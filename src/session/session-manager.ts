import type { ChatMessage, SessionRecord, ToolCall } from "../types/agent.js";
import { SessionStore } from "./session-store.js";

const CONTEXT_SUMMARY_PREFIX = "[context-summary]";
const SUMMARY_MAX_LINES = 18;
const SUMMARY_MAX_ITEM_LENGTH = 220;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeSummaryText(content: string, maxLength = SUMMARY_MAX_ITEM_LENGTH): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength)}...`;
}

function summarizeToolContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      summary?: unknown;
    };
    if (typeof parsed.summary === "string" && parsed.summary.trim().length > 0) {
      return normalizeSummaryText(parsed.summary);
    }
  } catch {
    // keep raw fallback below
  }

  return normalizeSummaryText(content);
}

function summarizeMessageForContext(message: ChatMessage): string | null {
  switch (message.role) {
    case "user":
      return message.content.trim().length > 0
        ? `user: ${normalizeSummaryText(message.content)}`
        : null;
    case "assistant":
      return message.content.trim().length > 0
        ? `assistant: ${normalizeSummaryText(message.content)}`
        : null;
    case "tool":
      return `tool(${message.name ?? "unknown"}): ${summarizeToolContent(message.content)}`;
    default:
      return null;
  }
}

function isContextSummaryMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && message.content.startsWith(CONTEXT_SUMMARY_PREFIX);
}

function hasDanglingToolMessages(messages: ChatMessage[]): boolean {
  const knownToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        knownToolCallIds.add(call.id);
      }
      continue;
    }

    if (message.role === "tool") {
      if (!message.toolCallId || !knownToolCallIds.has(message.toolCallId)) {
        return true;
      }
    }
  }

  return false;
}

function buildContextSummaryMessage(messages: ChatMessage[]): ChatMessage | null {
  const lines = messages
    .map((message) => summarizeMessageForContext(message))
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return null;
  }

  const clipped = lines.slice(-SUMMARY_MAX_LINES);
  const omittedCount = lines.length - clipped.length;
  const numbered = clipped.map((line, index) => `${index + 1}. ${line}`);

  const content = [
    CONTEXT_SUMMARY_PREFIX,
    "Historical context summary (auto-generated):",
    omittedCount > 0 ? `... ${omittedCount} earlier summary items omitted ...` : null,
    ...numbered,
    "Use recent messages below this summary as the source of truth."
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  return {
    role: "assistant",
    content
  };
}

export interface ContextCompressionResult {
  compressed: boolean;
  beforeMessageCount: number;
  afterMessageCount: number;
}

/** Sanitize a title into a safe filesystem prefix. */
export function sanitizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 30) || "untitled";
}

function createSessionId(title?: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (title) {
    const prefix = sanitizeTitle(title);
    return `${prefix}-${suffix}`;
  }
  // no custom title → purely random id (will be updated later via LLM)
  return suffix;
}

export class AmbiguousSessionError extends Error {
  constructor(public readonly candidates: SessionRecord[]) {
    super(`Multiple sessions match the prefix.`);
    this.name = "AmbiguousSessionError";
  }
}

export class SessionManager {
  private currentSession: SessionRecord | null = null;

  constructor(private readonly store: SessionStore) {}

  async initialize(): Promise<SessionRecord> {
    const latest = await this.store.loadLatest();
    if (latest) {
      this.currentSession = latest;
      return latest;
    }
    return this.createSession("new-session");
  }

  async createSession(title = "new-session"): Promise<SessionRecord> {
    const timestamp = nowIso();
    const id = createSessionId(title);
    const session: SessionRecord = {
      id,
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: []
    };
    await this.store.save(session);
    this.currentSession = session;
    return session;
  }

  /** Update the current session's title and id (with title prefix). Renames the .json file on disk. */
  async updateSessionTitle(newTitle: string): Promise<SessionRecord> {
    const session = this.getCurrentSession();
    const oldId = session.id;
    const newId = createSessionId(newTitle);
    session.id = newId;
    session.title = newTitle;
    if (oldId !== newId) {
      await this.store.rename(oldId, newId);
    }
    await this.store.save(session);
    return session;
  }

  async switchSession(sessionIdOrPrefix: string): Promise<SessionRecord> {
    // 1) exact match
    const exact = await this.store.load(sessionIdOrPrefix);
    if (exact) {
      this.currentSession = exact;
      return exact;
    }

    // 2) prefix match
    const all = await this.store.list();
    const candidates = all.filter((s) => s.id.startsWith(sessionIdOrPrefix));

    if (candidates.length === 0) {
      throw new Error(`Session not found: ${sessionIdOrPrefix}`);
    }
    if (candidates.length === 1) {
      const record = candidates[0]!;
      this.currentSession = record;
      return record;
    }

    // 3) multiple matches → throw with candidates
    throw new AmbiguousSessionError(candidates);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.store.list();
  }

  getCurrentSession(): SessionRecord {
    if (!this.currentSession) {
      throw new Error("Session not initialized.");
    }
    return this.currentSession;
  }

  getMessages(): ChatMessage[] {
    return [...this.getCurrentSession().messages];
  }

  getCurrentContextUsageTokens(): number {
    return this.getCurrentSession().lastUsageTotalTokens ?? 0;
  }

  async setCurrentContextUsageTokens(totalTokens: number): Promise<void> {
    const normalized = Number.isFinite(totalTokens)
      ? Math.max(0, Math.floor(totalTokens))
      : 0;
    const session = this.getCurrentSession();

    if (session.lastUsageTotalTokens === normalized) {
      return;
    }

    session.lastUsageTotalTokens = normalized;
    session.updatedAt = nowIso();
    await this.store.save(session);
  }

  async addUserMessage(content: string): Promise<void> {
    await this.appendMessage({ role: "user", content });
  }

  async addModelMessage(
    content: string,
    toolCalls?: ToolCall[],
    reasoning_content?: string,
  ): Promise<void> {
    await this.appendMessage({
      role: "assistant",
      content,
      toolCalls,
      reasoning_content,
    });
  }

  async addToolMessage(toolCallId: string, name: string, content: string): Promise<void> {
    await this.appendMessage({
      role: "tool",
      content,
      name,
      toolCallId
    });
  }

  getHistory(limit = 20): ChatMessage[] {
    const messages = this.getCurrentSession().messages;
    return messages.slice(Math.max(0, messages.length - limit));
  }

  async compressHistory(keepRecentMessages = 12): Promise<ContextCompressionResult> {
    const session = this.getCurrentSession();
    const beforeMessageCount = session.messages.length;
    const recentCount = Math.max(6, Math.floor(keepRecentMessages));
    const messagesWithoutSummary = session.messages.filter(
      (message) => !isContextSummaryMessage(message)
    );

    if (messagesWithoutSummary.length <= recentCount + 1) {
      return {
        compressed: false,
        beforeMessageCount,
        afterMessageCount: beforeMessageCount
      };
    }

    let splitIndex = Math.max(1, messagesWithoutSummary.length - recentCount);
    while (
      splitIndex > 0 &&
      hasDanglingToolMessages(messagesWithoutSummary.slice(splitIndex))
    ) {
      splitIndex -= 1;
    }

    if (splitIndex <= 0) {
      return {
        compressed: false,
        beforeMessageCount,
        afterMessageCount: beforeMessageCount
      };
    }

    const olderMessages = messagesWithoutSummary.slice(0, splitIndex);
    const recentMessages = messagesWithoutSummary.slice(splitIndex);
    const summaryMessage = buildContextSummaryMessage(olderMessages);

    if (!summaryMessage) {
      return {
        compressed: false,
        beforeMessageCount,
        afterMessageCount: beforeMessageCount
      };
    }

    session.messages = [summaryMessage, ...recentMessages];
    session.updatedAt = nowIso();
    await this.store.save(session);

    return {
      compressed: true,
      beforeMessageCount,
      afterMessageCount: session.messages.length
    };
  }

  private async appendMessage(message: ChatMessage): Promise<void> {
    const session = this.getCurrentSession();
    session.messages.push(message);
    session.updatedAt = nowIso();
    await this.store.save(session);
  }
}
