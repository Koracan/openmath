import type { ChatMessage, SessionRecord, ToolCall } from "../types/agent.js";
import { SessionStore } from "./session-store.js";

function nowIso(): string {
  return new Date().toISOString();
}

function createSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    const session: SessionRecord = {
      id: createSessionId(),
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: []
    };
    await this.store.save(session);
    this.currentSession = session;
    return session;
  }

  async switchSession(sessionId: string): Promise<SessionRecord> {
    const existing = await this.store.load(sessionId);
    if (!existing) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.currentSession = existing;
    return existing;
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
    await this.appendMessage({ role: "model", content, toolCalls, reasoning_content });
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
