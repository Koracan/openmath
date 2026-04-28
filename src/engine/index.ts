import path from "node:path";
import {
  appConfig,
  loadConfigFromFile as loadEnvFile,
  updateAppConfig,
} from "../config/env.js";
import { OpenAICompatibleModelAdapter } from "../config/models.js";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import type {
  OrchestratorOutput,
  OrchestratorStatusKind,
} from "../agent/orchestrator.js";
import { SessionManager } from "../session/session-manager.js";
import { SessionStore } from "../session/session-store.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ChatMessage, SessionRecord, ToolCall } from "../types/agent.js";
import type {
  ConfigOptions,
  EngineEventCallbacks,
  EngineState,
} from "../types/engine.js";

// ---------------------------------------------------------------------------
// Internal: generate a session title from the user's first message.
// ---------------------------------------------------------------------------

const TITLE_PROMPT =
  "You are a helpful assistant that generates short, concise session titles based on the user's first message in a math-oriented CLI tool.\nRules:\n- Respond with ONLY the title, no quotes, no punctuation, no extra text.\n- Max 5 words.\n- Summarize the mathematical topic concisely.";

async function generateSessionTitle(
  model: OpenAICompatibleModelAdapter,
  userMessage: string,
): Promise<string> {
  const result = await model.completeChat({
    systemPrompt: TITLE_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools: [],
    thinkingEnabled: false,
  });

  return result.content.trim().replace(/["']/g, "") || "untitled";
}

// ---------------------------------------------------------------------------
// OpenMathEngine — top-level controller for GUI / library consumers.
// ---------------------------------------------------------------------------

/**
 * OpenMathEngine is the main entry point for GUI consumers.
 *
 * Usage:
 * ```ts
 * const engine = new OpenMathEngine({ model: "deepseek-v4-flash" });
 * await engine.initialize();
 *
 * engine.setCallbacks({
 *   onStreamDelta: (chunk) => { /* update UI *\/ },
 *   onStateChange: (state) => { /* update header *\/ },
 * });
 *
 * await engine.sendMessage("Solve x^2 - 4 = 0");
 * ```
 */
export class OpenMathEngine {
  private sessions: SessionManager | null = null;
  private store: SessionStore | null = null;
  private tools: ToolRegistry | null = null;
  private model_: OpenAICompatibleModelAdapter | null = null;
  private orchestrator: AgentOrchestrator | null = null;

  private callbacks: EngineEventCallbacks = {};
  private _isBusy = false;
  private _initialized = false;

  constructor(config?: Partial<ConfigOptions>) {
    if (config) {
      updateAppConfig(config);
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Fetch a config snapshot from a `.env` file.
   * This is a static helper; call it before constructing the engine if you
   * want to preview or validate settings without initializing.
   */
  static loadConfigFromFile(filePath: string): void {
    loadEnvFile(filePath);
  }

  /**
   * Programmatically override config values at runtime.
   */
  updateConfig(partial: Partial<ConfigOptions>): void {
    updateAppConfig(partial);
    this.emitStateChange();
  }

  /**
   * Return a copy of the current runtime configuration.
   */
  getConfig(): ConfigOptions {
    const c = appConfig;
    return {
      provider: c.provider,
      baseUrl: c.baseUrl,
      model: c.model,
      apiKey: c.apiKey,
      timeoutMs: c.timeoutMs,
      maxContextLength: c.maxContextLength,
      maxRetries: c.maxRetries,
      retryBaseDelayMs: c.retryBaseDelayMs,
      rpmLimit: c.rpmLimit,
      pythonBin: c.pythonBin,
      pythonTimeoutSec: c.pythonTimeoutSec,
      pythonMaxOutputChars: c.pythonMaxOutputChars,
      mmaMcpEnabled: c.mmaMcpEnabled,
      mmaMcpTransport: c.mmaMcpTransport,
      mmaMcpCommand: c.mmaMcpCommand,
      mmaMcpProjectDir: c.mmaMcpProjectDir,
      mmaMcpExtraArgs: [...c.mmaMcpExtraArgs],
      mmaMcpHttpHost: c.mmaMcpHttpHost,
      mmaMcpHttpPort: c.mmaMcpHttpPort,
      mmaMcpTimeoutMs: c.mmaMcpTimeoutMs,
      mmaMcpToolCacheTtlMs: c.mmaMcpToolCacheTtlMs,
      mmaMcpMaxTextChars: c.mmaMcpMaxTextChars,
      fileWhitelist: [...c.fileWhitelist],
      thinkingEnabled: c.thinkingEnabled,
      reasoningEffort: c.reasoningEffort,
      workspaceRoot: c.workspaceRoot,
      sessionsDir: c.sessionsDir,
      scriptDir: c.scriptDir,
    };
  }

  /**
   * Initialize the engine: load sessions, register tools, connect to the API.
   * Must be called once before any other method.
   */
  async initialize(): Promise<void> {
    this.store = new SessionStore(appConfig.sessionsDir);
    await this.store.ensureReady();

    this.sessions = new SessionManager(this.store);
    await this.sessions.initialize();

    this.tools = ToolRegistry.createDefault();
    this.model_ = new OpenAICompatibleModelAdapter();
    this.orchestrator = new AgentOrchestrator({
      model: this.model_,
      sessions: this.sessions,
      tools: this.tools,
      workspaceRoot: appConfig.workspaceRoot,
    });

    this._initialized = true;
    this.emitStateChange();
    void this.emitSessionListChange();
  }

  /**
   * Tear down the engine. Call when the GUI unmounts.
   */
  async destroy(): Promise<void> {
    this._initialized = false;
    this.sessions = null;
    this.store = null;
    this.tools = null;
    this.model_ = null;
    this.orchestrator = null;
  }

  // -----------------------------------------------------------------------
  // Event callbacks
  // -----------------------------------------------------------------------

  /**
   * Register real-time event callbacks. Pass an object with any of the
   * supported callback properties.
   */
  setCallbacks(callbacks: EngineEventCallbacks): void {
    this.callbacks = callbacks;
  }

  // -----------------------------------------------------------------------
  // Chat
  // -----------------------------------------------------------------------

  /**
   * Send a user message and run the full agent loop (tools, streaming).
   * Returns the final assistant response text, or `null` if the loop was
   * interrupted.
   */
  async sendMessage(input: string): Promise<string | null> {
    this.assertReady();

    this._isBusy = true;
    this.emitStateChange();

    try {
      // Auto-generate title for brand-new sessions.
      if (this.sessions!.getCurrentSession().title === "new-session") {
        try {
          const generated = await generateSessionTitle(this.model_!, input);
          await this.sessions!.updateSessionTitle(generated);
          this.callbacks.onStatus?.("info", `Session title: ${generated}`);
          this.emitStateChange();
        } catch {
          // Non-fatal; keep default title.
        }
      }

      const output: OrchestratorOutput = {
        onStatus: (kind: OrchestratorStatusKind, message: string) => {
          this.callbacks.onStatus?.(kind, message);
        },
        onStreamStart: () => {
          this.callbacks.onStreamStart?.();
        },
        onStreamDelta: (chunk: string) => {
          this.callbacks.onStreamDelta?.(chunk);
        },
        onReasoningDelta: (chunk: string) => {
          this.callbacks.onReasoningDelta?.(chunk);
        },
        onStreamEnd: () => {
          this.callbacks.onStreamEnd?.("");
        },
      };

      const result = await this.orchestrator!.runUserTurn(input, output);

      this.emitStateChange();
      void this.emitSessionListChange();

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(message);
      return null;
    } finally {
      this._isBusy = false;
      this.emitStateChange();
    }
  }

  // -----------------------------------------------------------------------
  // Sessions
  // -----------------------------------------------------------------------

  /** List all sessions (newest first). */
  async listSessions(): Promise<SessionRecord[]> {
    this.assertReady();
    return this.sessions!.listSessions();
  }

  /** Create a new session and switch to it. */
  async createSession(title?: string): Promise<SessionRecord> {
    this.assertReady();
    const session = await this.sessions!.createSession(title);
    this.emitStateChange();
    void this.emitSessionListChange();
    return session;
  }

  /** Switch to an existing session by id (exact or prefix match). */
  async switchSession(sessionId: string): Promise<SessionRecord> {
    this.assertReady();
    const session = await this.sessions!.switchSession(sessionId);
    this.emitStateChange();
    return session;
  }

  /** Update the current session's title only (without changing id or filename). */
  async updateSessionTitle(newTitle: string): Promise<SessionRecord> {
    this.assertReady();

    // 防止在忙碌时修改标题
    if (this._isBusy) {
      throw new Error(
        "Cannot update session title while engine is processing a message.",
      );
    }

    const session = await this.sessions!.updateSessionTitle(newTitle);
    this.emitStateChange();
    void this.emitSessionListChange();
    return session;
  }

  /** Delete a session by id. */
  async deleteSession(sessionId: string): Promise<void> {
    this.assertReady();
    await this.store!.delete(sessionId);
    void this.emitSessionListChange();
  }

  /** Get the current session record. */
  getCurrentSession(): SessionRecord {
    this.assertReady();
    return this.sessions!.getCurrentSession();
  }

  /** Get messages of the current session. */
  getCurrentMessages(): ChatMessage[] {
    this.assertReady();
    return this.sessions!.getMessages();
  }

  // -----------------------------------------------------------------------
  // Workspace
  // -----------------------------------------------------------------------

  /**
   * Change the workspace root directory at runtime.
   * Also migrates sessionsDir and scriptDir to live under the new root,
   * and reloads sessions from the new location.
   */
  async setWorkspaceRoot(root: string): Promise<void> {
    this.assertReady();

    const normalized = path.resolve(root);
    const newSessionsDir = path.join(normalized, "data", "sessions");
    const newScriptDir = path.join(normalized, "data", "tmp", "scripts");

    updateAppConfig({
      workspaceRoot: normalized,
      sessionsDir: newSessionsDir,
      scriptDir: newScriptDir,
    });

    // Recreate store + session manager so they point to the new dir.
    this.store = new SessionStore(newSessionsDir);
    await this.store.ensureReady();

    this.sessions = new SessionManager(this.store);
    await this.sessions.initialize();

    this.orchestrator = new AgentOrchestrator({
      model: this.model_!,
      sessions: this.sessions!,
      tools: this.tools!,
      workspaceRoot: normalized,
    });

    this.emitStateChange();
    void this.emitSessionListChange();
  }

  /** Get the current workspace root. */
  getWorkspaceRoot(): string {
    return appConfig.workspaceRoot;
  }

  // -----------------------------------------------------------------------
  // State query
  // -----------------------------------------------------------------------

  /** Return a snapshot of the current engine state. */
  getState(): EngineState {
    const session = this.sessions?.getCurrentSession();
    const usage = this.sessions?.getCurrentContextUsageTokens() ?? 0;
    const maxLength = Math.max(1, appConfig.maxContextLength);

    return {
      modelName: appConfig.model,
      sessionTitle: session?.title ?? "",
      contextUsage: {
        used: Math.max(0, Math.floor(usage)),
        max: maxLength,
        percent: Math.round((usage / maxLength) * 100),
      },
      isBusy: this._isBusy,
      workspaceRoot: appConfig.workspaceRoot,
      currentSessionId: session?.id ?? "",
    };
  }

  /** Whether the engine is currently processing a message. */
  get isBusy(): boolean {
    return this._isBusy;
  }

  /** Whether the engine has been initialized. */
  get initialized(): boolean {
    return this._initialized;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private assertReady(): void {
    if (!this._initialized) {
      throw new Error(
        "OpenMathEngine is not initialized. Call await engine.initialize() first.",
      );
    }
  }

  private emitStateChange(): void {
    this.callbacks.onStateChange?.(this.getState());
  }

  private async emitSessionListChange(): Promise<void> {
    if (!this.sessions) {
      return;
    }
    const sessions = await this.sessions.listSessions();
    this.callbacks.onSessionListChange?.(sessions);
  }
}
