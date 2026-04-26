import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { appConfig } from "../config/env.js";
import type { ToolDefinition, ToolExecutionResult } from "../types/tool.js";

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function sanitizeScriptName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.endsWith(".py") ? safe : `${safe}.py`;
}

function cappedAppend(base: string, chunk: string, limit: number): string {
  if (base.length >= limit) {
    return base;
  }
  const next = base + chunk;
  return next.length <= limit ? next : next.slice(0, limit);
}

function truncateMarker(text: string, limit: number): string {
  if (text.length < limit) {
    return text;
  }
  return `${text}\n...<truncated>`;
}

async function runPythonScript(
  pythonBin: string,
  scriptPath: string,
  timeoutMs: number,
  maxOutputChars: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: path.dirname(scriptPath),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = cappedAppend(stdout, chunk.toString("utf8"), maxOutputChars);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = cappedAppend(stderr, chunk.toString("utf8"), maxOutputChars);
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: truncateMarker(stdout, maxOutputChars),
        stderr: truncateMarker(stderr, maxOutputChars),
        timedOut
      });
    });
  });
}

const runPythonArgsSchema = z.object({
  script: z.string().min(1),
  filename: z.string().min(1).optional(),
  timeoutSec: z.number().int().positive().max(300).optional()
});

export function createPythonTool(): ToolDefinition {
  return {
    name: "run_python_script",
    description:
      "Create and execute a Python script for numerical calculations, then return stdout and stderr.",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "Python source code to execute."
        },
        filename: {
          type: "string",
          description: "Optional script file name under data/tmp/scripts."
        },
        timeoutSec: {
          type: "number",
          description: "Optional timeout seconds."
        }
      },
      required: ["script"],
      additionalProperties: false
    },
    execute: async (args, context): Promise<ToolExecutionResult> => {
      const parsed = runPythonArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: "Invalid arguments for run_python_script.",
          error: parsed.error.message
        };
      }

      const input = parsed.data;
      await fs.mkdir(appConfig.scriptDir, { recursive: true });

      const fileName = input.filename
        ? sanitizeScriptName(input.filename)
        : `script-${Date.now()}.py`;
      const scriptPath = path.join(appConfig.scriptDir, fileName);

      await fs.writeFile(scriptPath, input.script, "utf8");

      const timeoutMs = (input.timeoutSec ?? appConfig.pythonTimeoutSec) * 1000;
      const result = await runPythonScript(
        appConfig.pythonBin,
        scriptPath,
        timeoutMs,
        appConfig.pythonMaxOutputChars
      );

      const relativePath = path
        .relative(context.workspaceRoot, scriptPath)
        .replace(/\\/g, "/");

      if (result.timedOut) {
        return {
          ok: false,
          summary: `Python script timed out at ${timeoutMs}ms.`,
          error: result.stderr || "Process timed out.",
          data: {
            scriptPath: relativePath,
            stdout: result.stdout,
            stderr: result.stderr
          }
        };
      }

      if ((result.exitCode ?? 1) !== 0) {
        return {
          ok: false,
          summary: `Python exited with code ${result.exitCode}.`,
          error: result.stderr || "Python execution failed.",
          data: {
            scriptPath: relativePath,
            stdout: result.stdout,
            stderr: result.stderr
          }
        };
      }

      return {
        ok: true,
        summary: "Python script executed successfully.",
        data: {
          scriptPath: relativePath,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        }
      };
    }
  };
}
