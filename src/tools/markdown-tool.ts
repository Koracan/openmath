import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { appConfig } from "../config/env.js";
import type { ToolDefinition, ToolExecutionResult } from "../types/tool.js";

function normalizePathPart(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\//, "").replace(/\/+$/, "");
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/^#+\s*/, "").trim();
}

function assertAllowedMarkdownPath(relativePath: string): string {
  const normalizedInput = normalizePathPart(relativePath);
  if (!normalizedInput.toLowerCase().endsWith(".md")) {
    throw new Error("Only .md files are allowed.");
  }

  const absolute = path.resolve(appConfig.workspaceRoot, normalizedInput);
  const relative = normalizePathPart(path.relative(appConfig.workspaceRoot, absolute));

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes workspace root.");
  }

  const allowed = appConfig.markdownWhitelist.some((prefix) => {
    const normalizedPrefix = normalizePathPart(prefix);
    return relative === normalizedPrefix || relative.startsWith(`${normalizedPrefix}/`);
  });

  if (!allowed) {
    throw new Error(
      `Path ${relative} is outside markdown whitelist: ${appConfig.markdownWhitelist.join(", ")}`
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

function replaceSection(
  source: string,
  heading: string,
  replacement: string,
  createIfMissing: boolean
): string {
  const targetHeading = normalizeHeading(heading);
  const lines = source.split(/\r?\n/);

  let headingIndex = -1;
  let headingLevel = 2;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    if (!match) {
      continue;
    }

    const hashes = match[1];
    const headingText = match[2];
    if (!hashes || !headingText) {
      continue;
    }

    if (normalizeHeading(headingText) === targetHeading) {
      headingIndex = index;
      headingLevel = hashes.length;
      break;
    }
  }

  const replacementLines = replacement.split(/\r?\n/);

  if (headingIndex === -1) {
    if (!createIfMissing) {
      throw new Error(`Heading not found: ${targetHeading}`);
    }

    const suffix = source.trim().length === 0 ? "" : "\n\n";
    return `${source}${suffix}## ${targetHeading}\n\n${replacement}`.replace(/\n{3,}/g, "\n\n");
  }

  let sectionEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    const hashes = match?.[1];
    if (hashes && hashes.length <= headingLevel) {
      sectionEnd = index;
      break;
    }
  }

  const next = [
    ...lines.slice(0, headingIndex + 1),
    "",
    ...replacementLines,
    ...lines.slice(sectionEnd)
  ];

  return next.join("\n").replace(/\n{3,}/g, "\n\n");
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
  heading: z.string().min(1),
  content: z.string(),
  createIfMissing: z.boolean().optional()
});

export function createMarkdownTools(): ToolDefinition[] {
  return [
    {
      name: "markdown_read_file",
      description: "Read a markdown file from the allowed workspace paths.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to the markdown file."
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
            summary: "Invalid arguments for markdown_read_file.",
            error: parsed.error.message
          };
        }

        try {
          const filePath = assertAllowedMarkdownPath(parsed.data.path);
          const content = await fs.readFile(filePath, "utf8");
          return {
            ok: true,
            summary: "Markdown file read successfully.",
            data: {
              path: normalizePathPart(parsed.data.path),
              content
            }
          };
        } catch (error) {
          return {
            ok: false,
            summary: "Failed to read markdown file.",
            error: (error as Error).message
          };
        }
      }
    },
    {
      name: "markdown_write_file",
      description: "Write full content to a markdown file using atomic replacement.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to the markdown file."
          },
          content: {
            type: "string",
            description: "Full markdown content to persist."
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
            summary: "Invalid arguments for markdown_write_file.",
            error: parsed.error.message
          };
        }

        try {
          const filePath = assertAllowedMarkdownPath(parsed.data.path);
          await atomicWrite(filePath, parsed.data.content);
          return {
            ok: true,
            summary: "Markdown file written successfully.",
            data: { path: normalizePathPart(parsed.data.path) }
          };
        } catch (error) {
          return {
            ok: false,
            summary: "Failed to write markdown file.",
            error: (error as Error).message
          };
        }
      }
    },
    {
      name: "markdown_append",
      description: "Append text to an existing markdown file or create it when missing.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to the markdown file."
          },
          content: {
            type: "string",
            description: "Markdown snippet to append."
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
            summary: "Invalid arguments for markdown_append.",
            error: parsed.error.message
          };
        }

        try {
          const filePath = assertAllowedMarkdownPath(parsed.data.path);
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
            summary: "Markdown content appended successfully.",
            data: { path: normalizePathPart(parsed.data.path) }
          };
        } catch (error) {
          return {
            ok: false,
            summary: "Failed to append markdown content.",
            error: (error as Error).message
          };
        }
      }
    },
    {
      name: "markdown_replace_section",
      description:
        "Replace content under a markdown heading while preserving other sections.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to the markdown file."
          },
          heading: {
            type: "string",
            description: "Heading text to replace, without leading hashes."
          },
          content: {
            type: "string",
            description: "New markdown content for this section."
          },
          createIfMissing: {
            type: "boolean",
            description: "Create section when heading does not exist. Defaults to true."
          }
        },
        required: ["path", "heading", "content"],
        additionalProperties: false
      },
      execute: async (args): Promise<ToolExecutionResult> => {
        const parsed = replaceArgsSchema.safeParse(args);
        if (!parsed.success) {
          return {
            ok: false,
            summary: "Invalid arguments for markdown_replace_section.",
            error: parsed.error.message
          };
        }

        try {
          const filePath = assertAllowedMarkdownPath(parsed.data.path);
          let source = "";
          try {
            source = await fs.readFile(filePath, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }

          const next = replaceSection(
            source,
            parsed.data.heading,
            parsed.data.content,
            parsed.data.createIfMissing ?? true
          );

          await atomicWrite(filePath, next);

          return {
            ok: true,
            summary: "Markdown section replaced successfully.",
            data: {
              path: normalizePathPart(parsed.data.path),
              heading: normalizeHeading(parsed.data.heading)
            }
          };
        } catch (error) {
          return {
            ok: false,
            summary: "Failed to replace markdown section.",
            error: (error as Error).message
          };
        }
      }
    }
  ];
}
