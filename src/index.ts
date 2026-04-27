#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { appConfig } from "./config/env.js";
import { parseCommand } from "./io/command-parser.js";
import {
  colorizeUserLabel,
  colorizeUserMessageBody,
  makePrompt,
  printChunk,
  printError,
  printInfo,
  printLineBreak,
  printWarn,
  resetTerminalStyle
} from "./io/stream.js";
import {
  AmbiguousSessionError,
  SessionManager
} from "./session/session-manager.js";
import { SessionStore } from "./session/session-store.js";
import { OpenAICompatibleModelAdapter } from "./config/models.js";
import { ToolRegistry } from "./tools/registry.js";
import { AgentOrchestrator } from "./agent/orchestrator.js";
import { renderMarkdownForTerminal } from "./io/markdown-renderer.js";
import type { ChatMessage, SessionRecord } from "./types/agent.js";

function formatContextUsage(usageTotalTokens: number): string {
  const usage = Math.max(0, Math.floor(usageTotalTokens));
  const maxLength = Math.max(1, appConfig.maxContextLength);
  const percent = Math.round((usage / maxLength) * 100);
  return `context: ${usage}/${maxLength}, ${percent}%`;
}

function printCurrentContextUsage(sessions: SessionManager): void {
  printInfo(formatContextUsage(sessions.getCurrentContextUsageTokens()));
}

function shouldShowInHistory(message: ChatMessage): boolean {
  if (message.role === "tool") {
    return false;
  }
  if (message.role !== "assistant" && message.role !== "user") {
    return false;
  }

  return message.content.trim().length > 0;
}

function printHistoryMessage(message: ChatMessage): void {
  const roleLabel = message.role === "user"
    ? "[user]"
    : `[${message.role.padEnd(9, " ")}]`;
  printInfo(message.role === "user" ? colorizeUserLabel(roleLabel) : roleLabel);

  const rendered = renderMarkdownForTerminal(message.content);
  const output = rendered.trim().length > 0 ? rendered : message.content;
  const body = output.trimEnd();
  printChunk(message.role === "user" ? colorizeUserMessageBody(body) : body);
  printLineBreak();
  printLineBreak();
}

function printHelp(): void {
  printInfo("Commands:");
  printInfo("  /new [title]           create and switch to a new session");
  printInfo("  /list                  list all sessions");
  printInfo("  /switch <id-prefix>    switch to a session (prefix match)");
  printInfo("  /history [limit]       show recent messages");
  printInfo("  /help                  show help");
  printInfo("  /exit                  exit the CLI");
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
      `${marker} ${session.title} | ${session.id} | messages ${session.messages.length} | updated ${session.updatedAt}`
    );
  }
}

/**
 * Call the LLM to generate a short session title from the user's first message.
 */
async function generateSessionTitle(
  model: OpenAICompatibleModelAdapter,
  userMessage: string
): Promise<string> {
  const TITLE_PROMPT = `\
You are a helpful assistant that generates short, concise session titles based on the user's first message in a math-oriented CLI tool.
Rules:
- Respond with ONLY the title, no quotes, no punctuation, no extra text.
- Max 5 words.
- Summarize the mathematical topic concisely.`;

  const result = await model.completeChat({
    systemPrompt: TITLE_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools: []
  });

  return result.content.trim().replace(/["'"]/g, "") || "untitled";
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
  if(appConfig.thinkingEnabled) {
    printInfo(`reasoning-effort=${appConfig.reasoningEffort}`);
  }
  printInfo(`active-session=${current.title}`);
  printCurrentContextUsage(sessions);
  printInfo("Type /help to show command list.");

  const rl = createInterface({ input, output });

  try {
    while (true) {
      const cur = sessions.getCurrentSession();
      const prompt = makePrompt(cur.title);
      const line = await rl.question(prompt);
      resetTerminalStyle();
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      const command = parseCommand(trimmed);
      if (command) {
        switch (command.type) {
          case "new": {
            const next = await sessions.createSession(command.title ?? "new-session");
            printInfo(`Switched to new session: ${next.title}`);
            printCurrentContextUsage(sessions);
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
              printInfo(`Switched to session: ${switched.title}`);
              printCurrentContextUsage(sessions);
            } catch (error) {
              if (error instanceof AmbiguousSessionError) {
                printWarn(
                  `Multiple sessions match "${command.sessionId}":`
                );
                for (const s of error.candidates) {
                  printInfo(`  ${s.title} | ${s.id}`);
                }
              } else {
                printError((error as Error).message);
              }
            }
            continue;
          }
          case "history": {
            const history = sessions
              .getHistory(command.limit)
              .filter((message) => shouldShowInHistory(message));
            if (history.length === 0) {
              printInfo("History is empty.");
              continue;
            }
            for (const message of history) {
              printHistoryMessage(message);
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

      // If the current session has no real title yet, generate one via LLM
      if (sessions.getCurrentSession().title === "new-session") {
        printInfo("(generating session title…)");
        try {
          const generated = await generateSessionTitle(model, trimmed);
          const updated = await sessions.updateSessionTitle(generated);
          printInfo(`Session title: ${updated.title}`);
        } catch {
          // fallback: leave as-is
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
