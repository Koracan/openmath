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
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastUsageTotalTokens?: number;
  messages: ChatMessage[];
}
