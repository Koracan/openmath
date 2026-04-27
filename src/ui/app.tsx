import React, { useEffect, useRef, useState, type JSX } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Markdown from "ink-markdown-es";
import { appConfig } from "../config/env.js";
import { OpenAICompatibleModelAdapter } from "../config/models.js";
import { AgentOrchestrator } from "../agent/orchestrator.js";
import type {
  OrchestratorOutput,
  OrchestratorStatusKind,
} from "../agent/orchestrator.js";
import { parseCommand } from "../io/command-parser.js";
import {
  createMarkdownStreamTransformer,
  transformMarkdownForDisplay,
} from "../io/markdown-renderer.js";
import type { MarkdownStreamTransformer } from "../io/markdown-renderer.js";
import {
  AmbiguousSessionError,
  SessionManager,
} from "../session/session-manager.js";
import { SessionStore } from "../session/session-store.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ChatMessage, SessionRecord } from "../types/agent.js";
import { MultilineInput } from "./multiline-input.js";

const HELP_TEXT = [
  "Commands:",
  "- /new [title]           create and switch to a new session",
  "- /list                  list all sessions",
  "- /switch <id-prefix>    switch to a session (prefix match)",
  "- /history [limit]       show recent messages",
  "- /help                  show help",
  "- /exit                  exit the CLI",
].join("\n");

type TranscriptItem =
  | {
      id: string;
      type: "message";
      role: "user" | "assistant";
      content: string;
    }
  | {
      id: string;
      type: "system";
      kind: OrchestratorStatusKind;
      content: string;
      markdown?: boolean;
    };

function formatContextUsage(usageTotalTokens: number): string {
  const usage = Math.max(0, Math.floor(usageTotalTokens));
  const maxLength = Math.max(1, appConfig.maxContextLength);
  const percent = Math.round((usage / maxLength) * 100);
  return `context: ${usage}/${maxLength}, ${percent}%`;
}

function shouldShowInHistory(
  message: ChatMessage,
): message is ChatMessage & { role: "user" | "assistant" } {
  if (message.role === "tool") {
    return false;
  }
  if (message.role !== "assistant" && message.role !== "user") {
    return false;
  }

  return message.content.trim().length > 0;
}

function buildTranscript(
  messages: ChatMessage[],
  nextId: () => string,
): TranscriptItem[] {
  return messages
    .filter((message) => shouldShowInHistory(message))
    .map((message) => {
      const content = transformMarkdownForDisplay(message.content);
      return {
        id: nextId(),
        type: "message",
        role: message.role,
        content,
      };
    });
}

function formatSessionList(
  sessions: SessionRecord[],
  currentId: string,
): string {
  if (sessions.length === 0) {
    return "No sessions found.";
  }

  const lines = ["Sessions:"];
  for (const session of sessions) {
    const marker = session.id === currentId ? "*" : " ";
    lines.push(
      `${marker} ${session.title} | ${session.id} | messages ${session.messages.length} | updated ${session.updatedAt}`,
    );
  }

  return lines.join("\n");
}

function formatHistoryOutput(messages: ChatMessage[], limit: number): string {
  const history = messages.filter((message) => shouldShowInHistory(message));
  if (history.length === 0) {
    return "History is empty.";
  }

  const lines = [`History (last ${limit}):`];
  for (const message of history) {
    const prefix = message.role === "user" ? "user:" : "assistant:";
    const content = transformMarkdownForDisplay(message.content);
    const trimmed = content.trimEnd();
    lines.push(trimmed ? `${prefix} ${trimmed}` : `${prefix} <empty>`);
  }

  return lines.join("\n");
}

async function generateSessionTitle(
  model: OpenAICompatibleModelAdapter,
  userMessage: string,
): Promise<string> {
  const TITLE_PROMPT =
    "You are a helpful assistant that generates short, concise session titles based on the user's first message in a math-oriented CLI tool.\nRules:\n- Respond with ONLY the title, no quotes, no punctuation, no extra text.\n- Max 5 words.\n- Summarize the mathematical topic concisely.";

  const result = await model.completeChat({
    systemPrompt: TITLE_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools: [],
    thinkingEnabled: false,
  });

  return result.content.trim().replace(/["']/g, "") || "untitled";
}

function MessageBlock({
  role,
  content,
}: {
  role: "user" | "assistant";
  content: string;
}): JSX.Element {
  const label = role === "user" ? "[user]" : "[assistant]";
  const color = role === "user" ? "cyan" : "green";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color}>{label}</Text>
      <Markdown>{content}</Markdown>
    </Box>
  );
}

function SystemBlock({
  kind,
  content,
  markdown,
}: {
  kind: OrchestratorStatusKind;
  content: string;
  markdown?: boolean;
}): JSX.Element {
  const color = kind === "error" ? "red" : kind === "warn" ? "yellow" : "gray";

  return (
    <Box flexDirection="column" marginBottom={1}>
      {markdown ? (
        <Markdown>{content}</Markdown>
      ) : (
        <Text color={color}>{content}</Text>
      )}
    </Box>
  );
}

export function App(): JSX.Element {
  const { exit } = useApp();
  const idRef = useRef(0);
  const isMountedRef = useRef(true);
  const sessionsRef = useRef<SessionManager | null>(null);
  const modelRef = useRef<OpenAICompatibleModelAdapter | null>(null);
  const orchestratorRef = useRef<AgentOrchestrator | null>(null);
  const streamTransformerRef = useRef<MarkdownStreamTransformer | null>(null);
  const streamBufferRef = useRef("");

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [streamingActive, setStreamingActive] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [sessionTitle, setSessionTitle] = useState("");
  const [contextUsage, setContextUsage] = useState("");

  const runIfMounted = (action: () => void): void => {
    if (!isMountedRef.current) {
      return;
    }

    action();
  };

  const nextId = (): string => {
    idRef.current += 1;
    return `${Date.now()}-${idRef.current}`;
  };

  const appendItem = (item: TranscriptItem): void => {
    runIfMounted(() => setItems((prev) => [...prev, item]));
  };

  const appendStatus = (
    kind: OrchestratorStatusKind,
    message: string,
  ): void => {
    appendItem({
      id: nextId(),
      type: "system",
      kind,
      content: `[${kind}] ${message}`,
      markdown: false,
    });
  };

  const appendSystemMarkdown = (
    kind: OrchestratorStatusKind,
    content: string,
  ): void => {
    appendItem({
      id: nextId(),
      type: "system",
      kind,
      content,
      markdown: true,
    });
  };

  const resetTranscript = (session: SessionRecord, note?: string): void => {
    const baseItems = buildTranscript(session.messages, nextId);
    if (!note) {
      runIfMounted(() => setItems(baseItems));
      return;
    }

    runIfMounted(() =>
      setItems([
        ...baseItems,
        {
          id: nextId(),
          type: "system",
          kind: "info",
          content: `[info] ${note}`,
          markdown: false,
        },
      ]),
    );
  };

  const updateContextUsage = (): void => {
    const sessions = sessionsRef.current;
    if (!sessions) {
      return;
    }

    runIfMounted(() =>
      setContextUsage(
        formatContextUsage(sessions.getCurrentContextUsageTokens()),
      ),
    );
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    const initialize = async (): Promise<void> => {
      try {
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
          workspaceRoot: appConfig.workspaceRoot,
        });

        if (!active) {
          return;
        }

        sessionsRef.current = sessions;
        modelRef.current = model;
        orchestratorRef.current = orchestrator;

        runIfMounted(() => {
          setSessionTitle(current.title);
          setContextUsage(
            formatContextUsage(sessions.getCurrentContextUsageTokens()),
          );
          setItems(buildTranscript(current.messages, nextId));
          setReady(true);
        });
      } catch (initError) {
        if (!active) {
          return;
        }

        runIfMounted(() => setError((initError as Error).message));
      }
    };

    void initialize();

    return () => {
      active = false;
    };
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
  });

  const handleSubmit = async (): Promise<void> => {
    if (!ready || isBusy) {
      return;
    }

    const fullInput = inputValue;
    runIfMounted(() => setInputValue(""));

    const trimmed = fullInput.trim();
    if (!trimmed) {
      return;
    }

    const command = fullInput.includes("\n") ? null : parseCommand(trimmed);
    runIfMounted(() => setIsBusy(true));

    try {
      if (command) {
        await handleCommand(command);
        return;
      }

      appendItem({
        id: nextId(),
        type: "message",
        role: "user",
        content: transformMarkdownForDisplay(fullInput),
      });

      const sessions = sessionsRef.current;
      const model = modelRef.current;
      const orchestrator = orchestratorRef.current;

      if (!sessions || !model || !orchestrator) {
        appendStatus("error", "Session is not ready.");
        return;
      }

      if (sessions.getCurrentSession().title === "new-session") {
        appendStatus("info", "Generating session title...");
        try {
          const generated = await generateSessionTitle(model, fullInput);
          const updated = await sessions.updateSessionTitle(generated);
          runIfMounted(() => setSessionTitle(updated.title));
          appendStatus("info", `Session title: ${updated.title}`);
        } catch {
          // ignore title generation errors
        }
      }

      const output: OrchestratorOutput = {
        onStatus: (kind, message) => {
          if (!isMountedRef.current) {
            return;
          }
          appendStatus(kind, message);
        },
        onStreamStart: () => {
          if (!isMountedRef.current) {
            return;
          }
          streamTransformerRef.current = createMarkdownStreamTransformer();
          streamBufferRef.current = "";
          runIfMounted(() => {
            setStreamingText("");
            setStreamingActive(true);
          });
        },
        onStreamDelta: (chunk) => {
          if (!isMountedRef.current) {
            return;
          }
          const transformer = streamTransformerRef.current;
          const nextChunk = transformer ? transformer.push(chunk) : chunk;
          if (!nextChunk) {
            return;
          }

          streamBufferRef.current += nextChunk;
          runIfMounted(() => setStreamingText(streamBufferRef.current));
        },
        onStreamEnd: () => {
          if (!isMountedRef.current) {
            return;
          }
          const transformer = streamTransformerRef.current;
          if (transformer) {
            const tail = transformer.flush();
            if (tail) {
              streamBufferRef.current += tail;
              runIfMounted(() => setStreamingText(streamBufferRef.current));
            }
          }

          runIfMounted(() => setStreamingActive(false));
        },
      };

      const finalContent = await orchestrator.runUserTurn(fullInput, output);
      if (!isMountedRef.current) {
        return;
      }
      if (finalContent && finalContent.trim().length > 0) {
        const streamed =
          streamBufferRef.current.trim().length > 0
            ? streamBufferRef.current
            : transformMarkdownForDisplay(finalContent);

        appendItem({
          id: nextId(),
          type: "message",
          role: "assistant",
          content: streamed,
        });
      }

      streamBufferRef.current = "";
      runIfMounted(() => {
        setStreamingText("");
        setStreamingActive(false);
      });
      updateContextUsage();
    } catch (runError) {
      appendStatus("error", (runError as Error).message);
    } finally {
      runIfMounted(() => setIsBusy(false));
    }
  };

  const handleCommand = async (
    command: ReturnType<typeof parseCommand>,
  ): Promise<void> => {
    const sessions = sessionsRef.current;
    if (!sessions || !command) {
      return;
    }

    switch (command.type) {
      case "new": {
        const next = await sessions.createSession(
          command.title ?? "new-session",
        );
        runIfMounted(() => setSessionTitle(next.title));
        resetTranscript(next, `Switched to new session: ${next.title}`);
        updateContextUsage();
        return;
      }
      case "list": {
        const all = await sessions.listSessions();
        appendStatus(
          "info",
          formatSessionList(all, sessions.getCurrentSession().id),
        );
        return;
      }
      case "switch": {
        try {
          const switched = await sessions.switchSession(command.sessionId);
          runIfMounted(() => setSessionTitle(switched.title));
          resetTranscript(switched, `Switched to session: ${switched.title}`);
          updateContextUsage();
        } catch (switchError) {
          if (switchError instanceof AmbiguousSessionError) {
            appendStatus(
              "warn",
              `Multiple sessions match "${command.sessionId}":`,
            );
            for (const candidate of switchError.candidates) {
              appendStatus("info", `  ${candidate.title} | ${candidate.id}`);
            }
          } else {
            appendStatus("error", (switchError as Error).message);
          }
        }
        return;
      }
      case "history": {
        const history = sessions.getHistory(command.limit);
        appendStatus("info", formatHistoryOutput(history, command.limit));
        return;
      }
      case "help": {
        appendSystemMarkdown("info", HELP_TEXT);
        return;
      }
      case "exit": {
        exit();
        return;
      }
      case "unknown": {
        appendStatus("warn", `Unknown command: ${command.raw}`);
        appendSystemMarkdown("info", HELP_TEXT);
        return;
      }
      default:
        return;
    }
  };

  if (error) {
    return <Text color="red">[error] {error}</Text>;
  }

  if (!ready) {
    return <Text>Loading...</Text>;
  }

  const prompt = `[user] openmath:${sessionTitle || "new-session"}> `;
  const showStreaming = streamingActive || streamingText.length > 0;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text>OpenMath CLI is ready.</Text>
        <Text>{`provider=${appConfig.provider}, model=${appConfig.model}`}</Text>
        {appConfig.thinkingEnabled ? (
          <Text>{`reasoning-effort=${appConfig.reasoningEffort}`}</Text>
        ) : null}
        <Text>{`active-session=${sessionTitle || "new-session"}`}</Text>
        <Text>{contextUsage}</Text>
        <Text>Type /help to show command list.</Text>
      </Box>

      {items.map((item) =>
        item.type === "message" ? (
          <MessageBlock key={item.id} role={item.role} content={item.content} />
        ) : (
          <SystemBlock
            key={item.id}
            kind={item.kind}
            content={item.content}
            markdown={item.markdown}
          />
        ),
      )}

      {showStreaming ? (
        <MessageBlock
          role="assistant"
          content={streamingText.length > 0 ? streamingText : "..."}
        />
      ) : null}

      <Box flexDirection="column">
        <Text color={isBusy ? "gray" : "cyan"}>{prompt}</Text>
        <MultilineInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          isDisabled={isBusy}
        />
      </Box>
    </Box>
  );
}
