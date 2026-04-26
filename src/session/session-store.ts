import fs from "node:fs/promises";
import path from "node:path";
import type { SessionRecord } from "../types/agent.js";

export class SessionStore {
  constructor(private readonly rootDir: string) {}

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async save(session: SessionRecord): Promise<void> {
    await this.ensureReady();
    const filePath = this.getFilePath(session.id);
    const tmpPath = `${filePath}.tmp-${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(session, null, 2), "utf8");
    await fs.rename(tmpPath, filePath);
  }

  async load(sessionId: string): Promise<SessionRecord | null> {
    await this.ensureReady();
    const filePath = this.getFilePath(sessionId);
    try {
      const content = await fs.readFile(filePath, "utf8");
      return JSON.parse(content) as SessionRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async list(): Promise<SessionRecord[]> {
    await this.ensureReady();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const sessions: SessionRecord[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const fullPath = path.join(this.rootDir, entry.name);
      const content = await fs.readFile(fullPath, "utf8");
      sessions.push(JSON.parse(content) as SessionRecord);
    }

    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions;
  }

  async loadLatest(): Promise<SessionRecord | null> {
    const all = await this.list();
    return all[0] ?? null;
  }

  async rename(oldId: string, newId: string): Promise<void> {
    const oldPath = this.getFilePath(oldId);
    const newPath = this.getFilePath(newId);
    await fs.rename(oldPath, newPath);
  }

  async delete(sessionId: string): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    await fs.rm(filePath, { force: true });
  }

  private getFilePath(sessionId: string): string {
    return path.join(this.rootDir, `${sessionId}.json`);
  }
}
