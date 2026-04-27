import { SYSTEM_PROMPT } from "./prompts.js";
import { OpenAICompatibleModelAdapter } from "../config/models.js";
import { appConfig } from "../config/env.js";
import { SessionManager } from "../session/session-manager.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  printModelPrefix,
  printChunk,
  printInfo,
  printLineBreak,
  printWarn
} from "../io/stream.js";
import { renderMarkdownForTerminal } from "../io/markdown-renderer.js";

interface OrchestratorOptions {
  model: OpenAICompatibleModelAdapter;
  sessions: SessionManager;
  tools: ToolRegistry;
  workspaceRoot: string;
}

const MAX_REASONING_PREVIEW_LENGTH = 240;
const CONTEXT_COMPRESSION_THRESHOLD = 0.75;
const CONTEXT_COMPRESSION_RECENT_MESSAGES = 12;

function formatContextUsage(usageTotalTokens: number): string {
  const maxContextLength = Math.max(1, appConfig.maxContextLength);
  const usage = Math.max(0, Math.floor(usageTotalTokens));
  const ratio = usage / maxContextLength;
  const percent = Math.round(ratio * 100);
  return `context: ${usage}/${maxContextLength}, ${percent}%`;
}

function shouldCompressContext(usageTotalTokens: number): boolean {
  if (!Number.isFinite(usageTotalTokens) || usageTotalTokens <= 0) {
    return false;
  }
  return usageTotalTokens / appConfig.maxContextLength > CONTEXT_COMPRESSION_THRESHOLD;
}

function getReasoningPreview(reasoningContent?: string): string | null {
  if (!reasoningContent) {
    return null;
  }

  const normalized = reasoningContent.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= MAX_REASONING_PREVIEW_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_REASONING_PREVIEW_LENGTH)}...`;
}

export class AgentOrchestrator {
  private readonly model: OpenAICompatibleModelAdapter;
  private readonly sessions: SessionManager;
  private readonly tools: ToolRegistry;
  private readonly workspaceRoot: string;

  constructor(options: OrchestratorOptions) {
    this.model = options.model;
    this.sessions = options.sessions;
    this.tools = options.tools;
    this.workspaceRoot = options.workspaceRoot;
  }

  private async maybeCompressContext(usageTotalTokens?: number): Promise<void> {
    if (typeof usageTotalTokens !== "number" || !shouldCompressContext(usageTotalTokens)) {
      return;
    }

    const compressed = await this.sessions.compressHistory(
      CONTEXT_COMPRESSION_RECENT_MESSAGES
    );
    if (!compressed.compressed) {
      return;
    }

    printInfo(`[context] before ${formatContextUsage(usageTotalTokens)}`);

    try {
      const probe = await this.model.completeChat({
        systemPrompt: `${SYSTEM_PROMPT}\n\nContext usage probe mode: reply with exactly ok and do not call tools.`,
        messages: this.sessions.getMessages(),
        tools: this.tools.getModelTools()
      });

      if (typeof probe.usageTotalTokens === "number") {
        await this.sessions.setCurrentContextUsageTokens(probe.usageTotalTokens);
        printInfo(`[context] after  ${formatContextUsage(probe.usageTotalTokens)}`);
        return;
      }

      printWarn("[context] compressed, but post-compression usage is unavailable.");
    } catch (error) {
      printWarn(`[context] compressed, but usage probe failed: ${(error as Error).message}`);
    }
  }

  async runUserTurn(userInput: string): Promise<void> {
    const lastKnownUsage = this.sessions.getCurrentContextUsageTokens();
    if (shouldCompressContext(lastKnownUsage)) {
      await this.maybeCompressContext(lastKnownUsage);
    }

    await this.sessions.addUserMessage(userInput);

    const maxToolRounds = -1; // no limit
    for (let round = 0; maxToolRounds < 0 || round < maxToolRounds; round += 1) {
      printModelPrefix();
      const model = await this.model.completeChat({
        systemPrompt: SYSTEM_PROMPT,
        messages: this.sessions.getMessages(),
        tools: this.tools.getModelTools()
      });

      let hasPrintedContent = false;
      if (model.content.trim().length > 0) {
        const rendered = renderMarkdownForTerminal(model.content);
        const output = rendered.trim().length > 0 ? rendered : model.content;
        printChunk(output.trimEnd());
        hasPrintedContent = true;
      }

      if (!hasPrintedContent && model.toolCalls.length > 0) {
        printChunk("(invoking tools)");
      }
      printLineBreak();

      await this.sessions.addModelMessage(
        model.content,
        model.toolCalls.length > 0 ? model.toolCalls : undefined,
        model.reasoning_content
      );

      if (typeof model.usageTotalTokens === "number") {
        await this.sessions.setCurrentContextUsageTokens(model.usageTotalTokens);
      }

      if (model.toolCalls.length === 0) {
        await this.maybeCompressContext(model.usageTotalTokens);
        return;
      }

      const reasoningPreview = getReasoningPreview(model.reasoning_content);
      if (reasoningPreview) {
        printInfo(`[reasoning] ${reasoningPreview}`);
      }

      const currentSession = this.sessions.getCurrentSession();
      for (const toolCall of model.toolCalls) {
        printInfo(`[tool] ${toolCall.name}`);
        const result = await this.tools.executeToolCall(toolCall, {
          workspaceRoot: this.workspaceRoot,
          sessionId: currentSession.id
        });

        await this.sessions.addToolMessage(
          toolCall.id,
          toolCall.name,
          JSON.stringify(result)
        );

        const short = result.ok
          ? result.summary
          : `failed: ${result.error ?? result.summary}`;
        printInfo(`[tool-result] ${short}`);
      }

      await this.maybeCompressContext(model.usageTotalTokens);
    }

    printWarn("Tool call loop reached max rounds for this turn.");
  }
}
