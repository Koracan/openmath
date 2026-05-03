import { tavily } from "@tavily/core";
import type { TavilyClient } from "@tavily/core";
import { z } from "zod";
import { appConfig } from "../config/env.js";
import type { ToolDefinition, ToolExecutionResult } from "../types/tool.js";

const MAX_QUERY_LENGTH = 500;
const MAX_RESULT_CONTENT_CHARS = 600;

let tavilyClient: TavilyClient | null = null;
let lastApiKey: string | null = null;

class TavilyRequestError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TavilyRequestError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function getTavilyClient(): TavilyClient {
    const apiKey = appConfig.tavilyApiKey;
  if (!tavilyClient || apiKey !== lastApiKey) {
    lastApiKey = apiKey;
    tavilyClient = tavily({ apiKey });
  }
  return tavilyClient;
}

async function requestTavilyWithRetry(input: {
  query: string;
  maxResults: number;
  searchDepth: "basic" | "advanced";
  topic: "general" | "news";
}): Promise<Awaited<ReturnType<ReturnType<typeof tavily>["search"]>>> {
  let lastError: Error | null = null;
  const timeoutSec = Math.max(1, Math.ceil(appConfig.tavilyTimeoutMs / 1000));

  for (let attempt = 0; attempt <= appConfig.maxRetries; attempt += 1) {
    try {
      const client = getTavilyClient();
      return await client.search(input.query, {
        maxResults: input.maxResults,
        searchDepth: input.searchDepth,
        topic: input.topic,
        includeRawContent: false,
        includeAnswer: true,
        timeout: timeoutSec,
      });
    } catch (error) {
      lastError = error as Error;
      const message = (error as Error).message.toLowerCase();
      const retryable =
        !message.includes("401") &&
        !message.includes("403") &&
        !message.includes("invalid api key");

      if (!retryable || attempt === appConfig.maxRetries) {
        throw new TavilyRequestError(
          `Tavily SDK request failed: ${(error as Error).message}`,
          false,
        );
      }

      const delayMs = appConfig.retryBaseDelayMs * 2 ** attempt;
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Tavily request failed without explicit error.");
}

const tavilyArgsSchema = z
  .object({
    query: z.string().min(1).max(MAX_QUERY_LENGTH),
    max_results: z.number().int().min(1).max(10).optional(),
    search_depth: z.enum(["basic", "advanced"]).optional(),
    topic: z.enum(["general", "news"]).optional(),
  })
  .strict();

export function createTavilySearchTool(): ToolDefinition {
  return {
    name: "search_web",
    description: "Search the web for current information.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results (1-10).",
        },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "Search depth: basic for most general topics, advanced for highly specialized topics",
        },
        topic: {
          type: "string",
          enum: ["general", "news"],
          description: "Search topic.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args: unknown): Promise<ToolExecutionResult> => {
      const parsed = tavilyArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: "Invalid arguments for search_web.",
          error: parsed.error.message,
        };
      }

      if (!appConfig.tavilyApiKey) {
        return {
          ok: false,
          summary: "Tavily API key is not configured.",
          error: "Set OPENMATH_TAVILY_API_KEY in your environment.",
        };
      }

      const input = parsed.data;
      const maxResults = input.max_results ?? appConfig.tavilyMaxResults;
      const searchDepth = input.search_depth ?? "basic";
      const topic = input.topic ?? "general";

      try {
        const response = await requestTavilyWithRetry({
          query: input.query,
          maxResults,
          searchDepth,
          topic,
        });

        const normalizedResults = response.results
          .slice(0, maxResults)
          .map((item) => ({
            title: item.title,
            url: item.url,
            content: clipText(item.content ?? "", MAX_RESULT_CONTENT_CHARS),
            score: item.score,
          }));

        return {
          ok: true,
          summary: `Search completed with ${normalizedResults.length} result(s).`,
          data: {
            query: response.query,
            answer: response.answer,
            response_time: response.responseTime,
            results: normalizedResults,
          },
        };
      } catch (error) {
        return {
          ok: false,
          summary: "Search request failed.",
          error: (error as Error).message,
        };
      }
    },
  };
}
