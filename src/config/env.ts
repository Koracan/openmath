import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  OPENMATH_PROVIDER: z.string().default("openai-compatible"),
  OPENMATH_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENMATH_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  OPENMATH_API_KEY: z.string().min(1, "OPENMATH_API_KEY is required"),
  OPENMATH_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  OPENMATH_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(2),
  OPENMATH_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(800),
  OPENMATH_RPM_LIMIT: z.coerce.number().int().positive().default(30),
  OPENMATH_PYTHON_BIN: z.string().min(1).default("python"),
  OPENMATH_PYTHON_TIMEOUT_SEC: z.coerce.number().int().positive().default(30),
  OPENMATH_PYTHON_MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(12_000),
  OPENMATH_MD_WHITELIST: z.string().default("notes,answers"),
  OPENMATH_THINKING_ENABLED: z.enum(["enabled", "disabled"]).default("enabled"),
  OPENMATH_REASONING_EFFORT: z.enum(["high", "max"]).default("high")
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
  maxRetries: env.OPENMATH_MAX_RETRIES,
  retryBaseDelayMs: env.OPENMATH_RETRY_BASE_DELAY_MS,
  rpmLimit: env.OPENMATH_RPM_LIMIT,
  pythonBin: env.OPENMATH_PYTHON_BIN,
  pythonTimeoutSec: env.OPENMATH_PYTHON_TIMEOUT_SEC,
  pythonMaxOutputChars: env.OPENMATH_PYTHON_MAX_OUTPUT_CHARS,
  markdownWhitelist: env.OPENMATH_MD_WHITELIST.split(",")
    .map((segment) => segment.trim().replace(/\\/g, "/").replace(/^\//, ""))
    .filter(Boolean),
  thinkingEnabled: env.OPENMATH_THINKING_ENABLED === "enabled",
  reasoningEffort: env.OPENMATH_REASONING_EFFORT as "high" | "max",
  workspaceRoot: process.cwd(),
  sessionsDir: path.join(process.cwd(), "data", "sessions"),
  scriptDir: path.join(process.cwd(), "data", "tmp", "scripts")
};
