import { z } from "zod";
import { extract } from "@langgraph-js/crawler";
import { appConfig } from "../config/env.js";
import type { ToolDefinition, ToolExecutionResult } from "../types/tool.js";

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

const openUrlArgsSchema = z
  .object({
    url: z.string().url(),
    extract_depth: z.enum(["basic", "advanced"]).optional(),
  })
  .strict();

export function createOpenUrlTool(): ToolDefinition {
  return {
    name: "open_url",
    description: "Fetch and extract readable page content from a URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
        extract_depth: { type: "string", enum: ["basic", "advanced"], description: "Extraction depth." },
      },
      required: ["url"],
      additionalProperties: false
    },
    execute: async (args: unknown): Promise<ToolExecutionResult> => {
      const parsed = openUrlArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, summary: "Invalid arguments for open_url.", error: parsed.error.message };
      }

      if (!appConfig.openUrlEnabled) {
        return { ok: false, summary: "open_url tool is disabled in configuration.", error: "Set OPENMATH_OPEN_URL=enabled in .env." };
      }

      const input = parsed.data;
      const extract_depth = input.extract_depth ?? "basic";
      const timeout = appConfig.openUrlTimeoutMs;
      const maxChars = appConfig.openUrlMaxChars ?? 12000;

      try {
        const response = await extract({
          urls: [input.url],
          format: "markdown",
          extract_depth: extract_depth as "basic" | "advanced",
          timeout
        });

        const result = response.results?.[0];
        const failed = response.failed_results?.[0];

        if (failed) {
          return { ok: false, summary: `Failed to extract ${failed.url}`, error: failed.error };
        }

        if (!result) {
          return { ok: false, summary: "No extractable content returned.", error: "No result from crawler." };
        }

        const content = clipText(result.raw_content ?? "", maxChars);

        return {
          ok: true,
          summary: `Extracted content from ${result.url}`,
          data: {
            url: result.url,
            content,
            format: "markdown",
            images: result.images ?? [],
            favicon: result.favicon ?? null
          }
        };
      } catch (error) {
        return { ok: false, summary: "Failed to extract URL content.", error: (error as Error).message };
      }
    }
  };
}
