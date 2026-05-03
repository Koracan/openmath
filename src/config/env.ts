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
  OPENMATH_PROVIDER: z.string(),
  OPENMATH_BASE_URL: z.string().url(),
  OPENMATH_MODEL: z.string(),
  OPENMATH_API_KEY: z.string(),
  OPENMATH_TIMEOUT_MS: z.coerce.number().int().positive(),
  OPENMATH_MAX_CONTEXT_LENGTH: z.coerce.number().int().positive(),
  OPENMATH_MAX_RETRIES: z.coerce.number().int().min(0).max(8),
  OPENMATH_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive(),
  OPENMATH_RPM_LIMIT: z.coerce.number().int().positive(),
  OPENMATH_PYTHON_BIN: z.string(),
  OPENMATH_PYTHON_TIMEOUT_SEC: z.coerce.number().int().positive(),
  OPENMATH_PYTHON_MAX_OUTPUT_CHARS: z.coerce.number().int().positive(),
  OPENMATH_MMA_MCP_ENABLED: z.enum(["enabled", "disabled"]),
  OPENMATH_MMA_MCP_TRANSPORT: z
    .enum(["stdio", "http"])
    ,
  OPENMATH_MMA_MCP_COMMAND: z.string(),
  OPENMATH_MMA_MCP_PROJECT_DIR: z
    .string(),
  OPENMATH_MMA_MCP_EXTRA_ARGS: z.string(),
  OPENMATH_MMA_MCP_HTTP_HOST: z.string(),
  OPENMATH_MMA_MCP_HTTP_PORT: z.coerce.number().int().positive(),
  OPENMATH_MMA_MCP_TIMEOUT_SEC: z.coerce.number().int().positive(),
  OPENMATH_MMA_MCP_TOOL_CACHE_TTL_SEC: z.coerce.number().int().positive(),
  OPENMATH_MMA_MCP_MAX_TEXT_CHARS: z.coerce.number().int().positive(),
  OPENMATH_OPEN_URL: z.enum(["enabled", "disabled"]),
  OPENMATH_OPEN_URL_TIMEOUT_SEC: z.coerce.number().int().positive(),
  OPENMATH_OPEN_URL_MAX_CHARS: z.coerce.number().int().positive(),
  OPENMATH_TAVILY_SEARCH_ENABLED: z.enum(["enabled", "disabled"]),
  OPENMATH_TAVILY_API_KEY: z.string(),
  OPENMATH_TAVILY_TIMEOUT_SEC: z.coerce.number().int().positive(),
  OPENMATH_TAVILY_MAX_RESULTS: z.coerce.number().int().positive(),
  OPENMATH_FILE_WHITELIST: z.string(),
  OPENMATH_THINKING_ENABLED: z.enum(["enabled", "disabled"]),
  OPENMATH_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high", "max", "xhigh"])
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

const env = parsed.data;

/** Mutable runtime configuration object. */
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
  openUrlEnabled: env.OPENMATH_OPEN_URL === "enabled",
  openUrlTimeoutMs: env.OPENMATH_OPEN_URL_TIMEOUT_SEC * 1000,
  openUrlMaxChars: env.OPENMATH_OPEN_URL_MAX_CHARS,
  tavilySearchEnabled: env.OPENMATH_TAVILY_SEARCH_ENABLED === "enabled",
  tavilyApiKey: env.OPENMATH_TAVILY_API_KEY,
  tavilyTimeoutMs: env.OPENMATH_TAVILY_TIMEOUT_SEC * 1000,
  tavilyMaxResults: env.OPENMATH_TAVILY_MAX_RESULTS,
  fileWhitelist: env.OPENMATH_FILE_WHITELIST.split(",")
    .map((segment) => segment.trim().replace(/\\/g, "/").replace(/^\//, ""))
    .filter(Boolean),
  thinkingEnabled: env.OPENMATH_THINKING_ENABLED === "enabled",
  reasoningEffort: env.OPENMATH_REASONING_EFFORT as "minimal" | "low" | "medium" | "high" | "max" | "xhigh",
  workspaceRoot: process.cwd(),
  sessionsDir: path.join(process.cwd(), "data", "sessions"),
  scriptDir: path.join(process.cwd(), "data", "tmp", "scripts")
};

/**
 * Update runtime config with partial overrides.
 * This allows GUI consumers to programmatically change settings
 * (e.g. model, API key, workspace root) without a .env reload.
 */
export function updateAppConfig(partial: Partial<typeof appConfig>): void {
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined && key in appConfig) {
      (appConfig as Record<string, unknown>)[key] = value;
    }
  }
}

/**
 * Load configuration from a custom .env file path.
 * Useful when the GUI lets the user select a config file.
 * This merges the file's variables into process.env and updates appConfig.
 */
export function loadConfigFromFile(filePath: string): void {
  dotenv.config({ path: filePath, override: true });

  const reParsed = envSchema.safeParse(process.env);
  if (!reParsed.success) {
    const details = reParsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration in ${filePath}: ${details}`);
  }

  const env = reParsed.data;
  appConfig.provider = env.OPENMATH_PROVIDER;
  appConfig.baseUrl = env.OPENMATH_BASE_URL.replace(/\/$/, "");
  appConfig.model = env.OPENMATH_MODEL;
  appConfig.apiKey = env.OPENMATH_API_KEY;
  appConfig.timeoutMs = env.OPENMATH_TIMEOUT_MS;
  appConfig.maxContextLength = env.OPENMATH_MAX_CONTEXT_LENGTH;
  appConfig.maxRetries = env.OPENMATH_MAX_RETRIES;
  appConfig.retryBaseDelayMs = env.OPENMATH_RETRY_BASE_DELAY_MS;
  appConfig.rpmLimit = env.OPENMATH_RPM_LIMIT;
  appConfig.pythonBin = env.OPENMATH_PYTHON_BIN;
  appConfig.pythonTimeoutSec = env.OPENMATH_PYTHON_TIMEOUT_SEC;
  appConfig.pythonMaxOutputChars = env.OPENMATH_PYTHON_MAX_OUTPUT_CHARS;
  appConfig.mmaMcpEnabled = env.OPENMATH_MMA_MCP_ENABLED === "enabled";
  appConfig.mmaMcpTransport = env.OPENMATH_MMA_MCP_TRANSPORT;
  appConfig.mmaMcpCommand = env.OPENMATH_MMA_MCP_COMMAND;
  appConfig.mmaMcpProjectDir = env.OPENMATH_MMA_MCP_PROJECT_DIR;
  appConfig.mmaMcpExtraArgs = env.OPENMATH_MMA_MCP_EXTRA_ARGS.split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
  appConfig.mmaMcpHttpHost = env.OPENMATH_MMA_MCP_HTTP_HOST;
  appConfig.mmaMcpHttpPort = env.OPENMATH_MMA_MCP_HTTP_PORT;
  appConfig.mmaMcpTimeoutMs = env.OPENMATH_MMA_MCP_TIMEOUT_SEC * 1000;
  appConfig.mmaMcpToolCacheTtlMs = env.OPENMATH_MMA_MCP_TOOL_CACHE_TTL_SEC * 1000;
  appConfig.mmaMcpMaxTextChars = env.OPENMATH_MMA_MCP_MAX_TEXT_CHARS;
  appConfig.openUrlEnabled = env.OPENMATH_OPEN_URL === "enabled";
  appConfig.tavilySearchEnabled = env.OPENMATH_TAVILY_SEARCH_ENABLED === "enabled";
  appConfig.tavilyApiKey = env.OPENMATH_TAVILY_API_KEY;
  appConfig.tavilyTimeoutMs = env.OPENMATH_TAVILY_TIMEOUT_SEC * 1000;
  appConfig.tavilyMaxResults = env.OPENMATH_TAVILY_MAX_RESULTS;
  appConfig.openUrlTimeoutMs = env.OPENMATH_OPEN_URL_TIMEOUT_SEC * 1000;
  appConfig.openUrlMaxChars = env.OPENMATH_OPEN_URL_MAX_CHARS;
  appConfig.fileWhitelist = env.OPENMATH_FILE_WHITELIST.split(",")
    .map((segment) => segment.trim().replace(/\\/g, "/").replace(/^\//, ""))
    .filter(Boolean);
  appConfig.thinkingEnabled = env.OPENMATH_THINKING_ENABLED === "enabled";
  appConfig.reasoningEffort = env.OPENMATH_REASONING_EFFORT as "minimal" | "low" | "medium" | "high" | "max" | "xhigh";
}
