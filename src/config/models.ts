// ---------------------------------------------------------------------------
// Shared types — public API for all model adapters
// ---------------------------------------------------------------------------

import type { ChatMessage, ToolCall } from "../types/agent.js";
import type { ModelFunctionTool } from "../types/tool.js";
import { appConfig } from "./env.js";
import { ModelRequestError } from "./adapters/errors.js";

export type { ModelRequestError };

export interface CompletionInput {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ModelFunctionTool[];
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  thinkingEnabled?: boolean;
}

export interface CompletionOutput {
  content: string;
  toolCalls: ToolCall[];
  reasoning_content?: string;
  usageTotalTokens?: number;
  /** Provider-specific metadata (e.g. raw Gemini parts for round-trip fidelity). */
  providerMetadata?: Record<string, unknown>;
}

/** Adapter interface that all model providers must implement. */
export interface ModelAdapter {
  completeChat(input: CompletionInput): Promise<CompletionOutput>;
}

// ---------------------------------------------------------------------------
// Re-exports — individual adapters live in src/config/adapters/
// ---------------------------------------------------------------------------

import { OpenAICompatibleModelAdapter } from "./adapters/openai-compatible.js";
import { GoogleGenaiModelAdapter } from "./adapters/google.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate ModelAdapter based on the current provider config.
 */
export function createModelAdapter(): ModelAdapter {
  switch (appConfig.provider) {
    case "google":
      return new GoogleGenaiModelAdapter();
    case "openai-compatible":
    case "anthropic":
      return new OpenAICompatibleModelAdapter();
    default:
      throw new Error(`Unknown provider: ${appConfig.provider}`);
  }
}
