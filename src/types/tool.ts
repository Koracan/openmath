import type { ToolCall } from "./agent.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, context: ToolContext) => Promise<ToolExecutionResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
}

export interface ToolExecutionResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
}

export interface ToolInvocation {
  toolCall: ToolCall;
  context: ToolContext;
}

export interface ModelFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
