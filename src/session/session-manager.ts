import type { ChatMessage, SessionRecord, ToolCall } from "../types/agent.js";
import { SessionStore } from "./session-store.js";

function nowIso(): string {
  return new Date().toISOString();
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
    return this.createSession("default");
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

  async addUserMessage(content: string): Promise<void> {
    await this.appendMessage({ role: "user", content });
  }

  async addModelMessage(content: string, toolCalls?: ToolCall[], reasoning_content?: string): Promise<void> {
    await this.appendMessage({ role: "assistant", content, toolCalls, reasoning_content });
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

  private async appendMessage(message: ChatMessage): Promise<void> {
    const session = this.getCurrentSession();
    session.messages.push(message);
    session.updatedAt = nowIso();
    await this.store.save(session);
  }
}
