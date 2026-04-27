import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load .env from package installation directory as fallback.
// This file is at <packageRoot>/dist/config/env.js → packageRoot is two levels up.
const __filename = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(__filename, "..", "..", "..");

// 1) Try cwd first — user can override package defaults
dotenv.config();
// 2) Fallback to package root — won't override already-set variables
dotenv.config({ path: path.join(packageRoot, ".env"), override: false });

const envSchema = z.object({
  OPENMATH_PROVIDER: z.string().default("openai-compatible"),
  OPENMATH_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENMATH_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  OPENMATH_API_KEY: z.string().min(1, "OPENMATH_API_KEY is required"),
  OPENMATH_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  OPENMATH_MAX_CONTEXT_LENGTH: z.coerce.number().int().positive().default(128_000),
  OPENMATH_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(2),
  OPENMATH_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(800),
  OPENMATH_RPM_LIMIT: z.coerce.number().int().positive().default(30),
  OPENMATH_PYTHON_BIN: z.string().min(1).default("python"),
  OPENMATH_PYTHON_TIMEOUT_SEC: z.coerce.number().int().positive().default(30),
  OPENMATH_PYTHON_MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(12_000),
  OPENMATH_MMA_MCP_ENABLED: z.enum(["enabled", "disabled"]).default("enabled"),
  OPENMATH_MMA_MCP_TRANSPORT: z
    .enum(["stdio", "http"])
    .default(process.platform === "win32" ? "http" : "stdio"),
  OPENMATH_MMA_MCP_COMMAND: z.string().min(1).default("uv"),
  OPENMATH_MMA_MCP_PROJECT_DIR: z
    .string()
    .min(1)
    .default("C:/Users/korac/source/Python/mma-mcp"),
  OPENMATH_MMA_MCP_EXTRA_ARGS: z.string().default(""),
  OPENMATH_MMA_MCP_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  OPENMATH_MMA_MCP_HTTP_PORT: z.coerce.number().int().positive().default(18080),
  OPENMATH_MMA_MCP_TIMEOUT_SEC: z.coerce.number().int().positive().default(45),
  OPENMATH_MMA_MCP_TOOL_CACHE_TTL_SEC: z.coerce.number().int().positive().default(30),
  OPENMATH_MMA_MCP_MAX_TEXT_CHARS: z.coerce.number().int().positive().default(12_000),
  OPENMATH_MD_WHITELIST: z.string().default("notes,answers"),
  OPENMATH_THINKING_ENABLED: z.enum(["enabled", "disabled"]).default("enabled"),
  OPENMATH_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high", "max", "xhigh"]).default("high")
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

const env = parsed.data;

export const appConfig = {
  provider: env.OPENMATH_PROVIDER,
  baseUrl: env.OPENMATH_BASE_URL.replace(/\/$/, ""),
  model: env.OPENMATH_MODEL,
  apiKey: env.OPENMATH_API_KEY,
  timeoutMs: env.OPENMATH_TIMEOUT_MS,
  maxContextLength: env.OPENMATH_MAX_CONTEXT_LENGTH,
  maxRetries: env.OPENMATH_MAX_RETRIES,
  retryBaseDelayMs: env.OPENMATH_RETRY_BASE_DELAY_MS,
  rpmLimit: env.OPENMATH_RPM_LIMIT,
  pythonBin: env.OPENMATH_PYTHON_BIN,
  pythonTimeoutSec: env.OPENMATH_PYTHON_TIMEOUT_SEC,
  pythonMaxOutputChars: env.OPENMATH_PYTHON_MAX_OUTPUT_CHARS,
  mmaMcpEnabled: env.OPENMATH_MMA_MCP_ENABLED === "enabled",
  mmaMcpTransport: env.OPENMATH_MMA_MCP_TRANSPORT,
  mmaMcpCommand: env.OPENMATH_MMA_MCP_COMMAND,
  mmaMcpProjectDir: env.OPENMATH_MMA_MCP_PROJECT_DIR,
  mmaMcpExtraArgs: env.OPENMATH_MMA_MCP_EXTRA_ARGS.split(",")
    .map((segment) => segment.trim())
    .filter(Boolean),
  mmaMcpHttpHost: env.OPENMATH_MMA_MCP_HTTP_HOST,
  mmaMcpHttpPort: env.OPENMATH_MMA_MCP_HTTP_PORT,
  mmaMcpTimeoutMs: env.OPENMATH_MMA_MCP_TIMEOUT_SEC * 1000,
  mmaMcpToolCacheTtlMs: env.OPENMATH_MMA_MCP_TOOL_CACHE_TTL_SEC * 1000,
  mmaMcpMaxTextChars: env.OPENMATH_MMA_MCP_MAX_TEXT_CHARS,
  markdownWhitelist: env.OPENMATH_MD_WHITELIST.split(",")
    .map((segment) => segment.trim().replace(/\\/g, "/").replace(/^\//, ""))
    .filter(Boolean),
  thinkingEnabled: env.OPENMATH_THINKING_ENABLED === "enabled",
  reasoningEffort: env.OPENMATH_REASONING_EFFORT as "minimal" | "low" | "medium" | "high" | "max" | "xhigh",
  workspaceRoot: process.cwd(),
  sessionsDir: path.join(process.cwd(), "data", "sessions"),
  scriptDir: path.join(process.cwd(), "data", "tmp", "scripts")
};
