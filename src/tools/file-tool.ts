import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { appConfig } from "../config/env.js";
import type { ToolDefinition, ToolExecutionResult } from "../types/tool.js";

function normalizePathPart(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\//, "").replace(/\/+$/, "");
}


function assertAllowedFilePath(relativePath: string): string {
  const normalizedInput = normalizePathPart(relativePath);

  const absolute = path.resolve(appConfig.workspaceRoot, normalizedInput);
  const relative = normalizePathPart(path.relative(appConfig.workspaceRoot, absolute));

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes workspace root.");
  }

  const whitelist = ["data/notes",...appConfig.fileWhitelist];
  const allowed = whitelist.some((prefix) => {
    const normalizedPrefix = normalizePathPart(prefix);
    return relative === normalizedPrefix || relative.startsWith(`${normalizedPrefix}/`);
  });

  if (!allowed) {
    throw new Error(
      `Path ${relative} is outside allowed file paths: ${appConfig.fileWhitelist.join(", ")}`
    );
  }

  return absolute;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

function replaceLines(
  source: string,
  startLine: number,
  endLine: number,
  replacement: string
): string {
  const lines = source.split(/\r?\n/);
  const totalLines = lines.length;

  if (startLine > totalLines || endLine > totalLines) {
    throw new Error(
      `Line range ${startLine}-${endLine} is outside file length (${totalLines} lines).`
    );
  }

  const replacementLines = replacement.length > 0
    ? replacement.split(/\r?\n/)
    : [];
  const startIndex = startLine - 1;
  const endIndex = endLine;

  const next = [
    ...lines.slice(0, startIndex),
    ...replacementLines,
    ...lines.slice(endIndex)
  ];

  return next.join("\n");
}

const readArgsSchema = z.object({
  path: z.string().min(1)
});

const writeArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

const appendArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1)
});

const replaceArgsSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  content: z.string()
});

export function createFileTools(): ToolDefinition[] {
  return [
    {
      name: "read_file",
      description: "Read a file from the allowed workspace paths.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to the file."
          }
        },
        required: ["path"],
        additionalProperties: false
      },
      execute: async (args): Promise<ToolExecutionResult> => {
        const parsed = readArgsSchema.safeParse(args);
        if (!parsed.success) {
          return {
            ok: false,
            summary: "Invalid arguments for read_file.",
            error: parsed.error.message
          };
        }

        try {
          const normalizedInput = normalizePathPart(parsed.data.path);
          const filePath = path.resolve(appConfig.workspaceRoot, normalizedInput);
          // we allow read access to any file
          const content = await fs.readFile(filePath, "utf8");
          return {
            ok: true,
            summary: "File read successfully.",
            data: {
              path: normalizePathPart(parsed.data.path),
              content
            }
          };
        } catch (error) {
          return {
            ok: false,
            summary: "Failed to read file.",
            error: (error as Error).message
          };
        }
      }
    },
    {
      name: "write_file",
      description: "Write full content to a file using atomic replacement.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to the file."
          },
          content: {
            type: "string",
            description: "Full content to persist."
          }
        },
        required: ["path", "content"],
        additionalProperties: false
      },
      execute: async (args): Promise<ToolExecutionResult> => {
        const parsed = writeArgsSchema.safeParse(args);
        if (!parsed.success) {
          return {
            ok: false,
            summary: "Invalid arguments for write_file.",
            error: parsed.error.message
          };
        }

        try {
          const filePath = assertAllowedFilePath(parsed.data.path);
          await atomicWrite(filePath, parsed.data.content);
          return {
            ok: true,
            summary: "File written successfully.",
            data: { path: normalizePathPart(parsed.data.path) }
          };
        } catch (error) {
          return {
            ok: false,
            summary: "Failed to write file.",
            error: (error as Error).message
          };
        }
      }
    },
    {
      name: "file_append",
      description: "Append text to an existing file or create it when missing.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to the file."
          },
          content: {
            type: "string",
            description: "Text to append."
          }
        },
        required: ["path", "content"],
        additionalProperties: false
      },
      execute: async (args): Promise<ToolExecutionResult> => {
        const parsed = appendArgsSchema.safeParse(args);
        if (!parsed.success) {
          return {
            ok: false,
            summary: "Invalid arguments for file_append.",
            error: parsed.error.message
          };
        }

        try {
          const filePath = assertAllowedFilePath(parsed.data.path);
          let existing = "";
          try {
            existing = await fs.readFile(filePath, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }

          const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
          const next = `${existing}${separator}${parsed.data.content}`;
          await atomicWrite(filePath, next);

          return {
            ok: true,
            summary: "File content appended successfully.",
            data: { path: normalizePathPart(parsed.data.path) }
          };
        } catch (error) {
          return {
            ok: false,
            summary: "Failed to append file content.",
            error: (error as Error).message
          };
        }
      }
    },
    {
      name: "file_replace_lines",
      description:
        "Replace the inclusive line range [startLine, endLine] (1-based) with new content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to the file."
          },
          startLine: {
            type: "number",
            description: "Start line number (1-based, inclusive)."
          },
          endLine: {
            type: "number",
            description: "End line number (1-based, inclusive)."
          },
          content: {
            type: "string",
            description: "Replacement content for the line range."
          }
        },
        required: ["path", "startLine", "endLine", "content"],
        additionalProperties: false
      },
      execute: async (args): Promise<ToolExecutionResult> => {
        const parsed = replaceArgsSchema.safeParse(args);
        if (!parsed.success) {
          return {
            ok: false,
            summary: "Invalid arguments for file_replace_lines.",
            error: parsed.error.message
          };
        }

        if (parsed.data.endLine < parsed.data.startLine) {
          return {
            ok: false,
            summary: "Invalid line range for file_replace_lines.",
            error: "endLine must be greater than or equal to startLine."
          };
        }

        try {
          const filePath = assertAllowedFilePath(parsed.data.path);
          let source = "";
          try {
            source = await fs.readFile(filePath, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }

          const next = replaceLines(
            source,
            parsed.data.startLine,
            parsed.data.endLine,
            parsed.data.content
          );

          await atomicWrite(filePath, next);

          return {
            ok: true,
            summary: "File lines replaced successfully.",
            data: {
              path: normalizePathPart(parsed.data.path),
              startLine: parsed.data.startLine,
              endLine: parsed.data.endLine
            }
          };
        } catch (error) {
          return {
            ok: false,
            summary: "Failed to replace file lines.",
            error: (error as Error).message
          };
        }
      }
    }
  ];
}
