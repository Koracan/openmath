import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { appConfig } from "./config/env.js";
import { parseCommand } from "./io/command-parser.js";
import {
  makePrompt,
  printError,
  printInfo,
  printWarn
} from "./io/stream.js";
import { SessionManager } from "./session/session-manager.js";
import { SessionStore } from "./session/session-store.js";
import { OpenAICompatibleModelAdapter } from "./config/models.js";
import { ToolRegistry } from "./tools/registry.js";
import { AgentOrchestrator } from "./agent/orchestrator.js";
import type { ChatMessage, SessionRecord } from "./types/agent.js";

function summarizeContent(content: string, maxLength = 120): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxLength)}...`;
}

function formatHistoryMessage(message: ChatMessage): string {
  if (message.role === "tool") {
    try {
      const parsed = JSON.parse(message.content) as {
        summary?: string;
      };
      return `[tool] ${message.name ?? "unknown"}: ${parsed.summary ?? "(no summary)"}`;
    } catch {
      return `[tool] ${message.name ?? "unknown"}: ${summarizeContent(message.content)}`;
    }
  }

  const role = message.role.padEnd(9, " ");
  return `[${role}] ${summarizeContent(message.content)}`;
}

function printHelp(): void {
  printInfo("Commands:");
  printInfo("  /new [title]       create and switch to a new session");
  printInfo("  /list              list all sessions");
  printInfo("  /switch <id>       switch to an existing session");
  printInfo("  /history [limit]   show recent messages");
  printInfo("  /help              show help");
  printInfo("  /exit              exit the CLI");
}

function printSessionList(sessions: SessionRecord[], currentId: string): void {
  if (sessions.length === 0) {
    printInfo("No sessions found.");
    return;
  }

  printInfo("Sessions:");
  for (const session of sessions) {
    const marker = session.id === currentId ? "*" : " ";
    printInfo(
      `${marker} ${session.id} | ${session.title} | updated ${session.updatedAt} | messages ${session.messages.length}`
    );
  }
}

async function main(): Promise<void> {
  const store = new SessionStore(appConfig.sessionsDir);
  await store.ensureReady();

  const sessions = new SessionManager(store);
  const current = await sessions.initialize();

  const tools = ToolRegistry.createDefault();
  const model = new OpenAICompatibleModelAdapter();
  const orchestrator = new AgentOrchestrator({
    model,
    sessions,
    tools,
    workspaceRoot: appConfig.workspaceRoot
  });

  printInfo("OpenMath CLI is ready.");
  printInfo(`provider=${appConfig.provider}, model=${appConfig.model}`);
  printInfo(`active-session=${current.id}`);
  printInfo("Type /help to show command list.");

  const rl = createInterface({ input, output });

  try {
    while (true) {
      const prompt = makePrompt(sessions.getCurrentSession().id);
      const line = await rl.question(prompt);
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      const command = parseCommand(trimmed);
      if (command) {
        switch (command.type) {
          case "new": {
            const next = await sessions.createSession(command.title ?? "new-session");
            printInfo(`Switched to new session: ${next.id}`);
            continue;
          }
          case "list": {
            const all = await sessions.listSessions();
            printSessionList(all, sessions.getCurrentSession().id);
            continue;
          }
          case "switch": {
            try {
              const switched = await sessions.switchSession(command.sessionId);
              printInfo(`Switched to session: ${switched.id}`);
            } catch (error) {
              printError((error as Error).message);
            }
            continue;
          }
          case "history": {
            const history = sessions.getHistory(command.limit);
            if (history.length === 0) {
              printInfo("History is empty.");
              continue;
            }
            for (const message of history) {
              printInfo(formatHistoryMessage(message));
            }
            continue;
          }
          case "help": {
            printHelp();
            continue;
          }
          case "exit": {
            printInfo("Bye.");
            return;
          }
          case "unknown": {
            printWarn(`Unknown command: ${command.raw}`);
            printHelp();
            continue;
          }
          default:
            continue;
        }
      }

      try {
        await orchestrator.runUserTurn(trimmed);
      } catch (error) {
        printError((error as Error).message);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  printError((error as Error).message);
  process.exitCode = 1;
});
