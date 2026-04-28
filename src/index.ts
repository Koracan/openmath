#!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { App } from "./ui/app.js";

// ========================================================================
// Public API — consumed by GUI / library consumers via:
//   import { OpenMathEngine } from "openmath-ai";
// ========================================================================

export { OpenMathEngine } from "./engine/index.js";
export type { ConfigOptions, EngineState, EngineEventCallbacks, ContextUsage } from "./types/engine.js";
export type { SessionRecord, ChatMessage, ToolCall } from "./types/agent.js";
export type { ToolDefinition, ToolExecutionResult, ToolContext, ModelFunctionTool } from "./types/tool.js";
export type { OrchestratorStatusKind, OrchestratorOutput } from "./agent/orchestrator.js";

// ========================================================================
// CLI entry — only renders the Ink-based terminal UI when run interactively.
// When imported as a library (GUI), Ink is never rendered.
// ========================================================================

if (process.stdin.isTTY) {
  render(React.createElement(App));
}
