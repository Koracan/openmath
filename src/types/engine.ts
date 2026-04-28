import type { SessionRecord } from "./agent.js";
import type { OrchestratorStatusKind } from "../agent/orchestrator.js";

/**
 * Full set of configurable options for the OpenMath engine.
 * Mirrors the .env configuration schema.
 */
export interface ConfigOptions {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxContextLength: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  rpmLimit: number;
  pythonBin: string;
  pythonTimeoutSec: number;
  pythonMaxOutputChars: number;
  mmaMcpEnabled: boolean;
  mmaMcpTransport: "stdio" | "http";
  mmaMcpCommand: string;
  mmaMcpProjectDir: string;
  mmaMcpExtraArgs: string[];
  mmaMcpHttpHost: string;
  mmaMcpHttpPort: number;
  mmaMcpTimeoutMs: number;
  mmaMcpToolCacheTtlMs: number;
  mmaMcpMaxTextChars: number;
  fileWhitelist: string[];
  thinkingEnabled: boolean;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "max" | "xhigh";
  workspaceRoot: string;
  sessionsDir: string;
  scriptDir: string;
}

/** Context usage snapshot. */
export interface ContextUsage {
  used: number;
  max: number;
  percent: number;
}

/** Snapshot of observable engine state, consumed by GUI for header display etc. */
export interface EngineState {
  modelName: string;
  sessionTitle: string;
  contextUsage: ContextUsage;
  isBusy: boolean;
  workspaceRoot: string;
  currentSessionId: string;
}

/**
 * Callback interface for real-time events emitted by the engine.
 * A GUI can set these to react to streaming, status changes, etc.
 */
export interface EngineEventCallbacks {
  /** Fired whenever the engine state changes (busy, session, context usage, etc.). */
  onStateChange?: (state: EngineState) => void;
  /** Fired when the model starts streaming a response. */
  onStreamStart?: () => void;
  /** Fired for each text chunk in the streaming response. */
  onStreamDelta?: (chunk: string) => void;
  /** Fired when streaming ends. */
  onStreamEnd?: (fullContent: string) => void;
  /** Fired for status messages (tool calls, context compression, etc.). */
  onStatus?: (kind: OrchestratorStatusKind, message: string) => void;
  /** Fired on errors. */
  onError?: (message: string) => void;
  /** Fired when the session list changes (create/delete sessions). */
  onSessionListChange?: (sessions: SessionRecord[]) => void;
}
