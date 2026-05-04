export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoning_content?: string;
  /** Provider-specific metadata (e.g. raw Gemini parts for round-trip fidelity). */
  providerMetadata?: Record<string, unknown>;
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastUsageTotalTokens?: number;
  messages: ChatMessage[];
}
