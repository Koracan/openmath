import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionChunk,
} from "openai/resources/chat/completions";
import type { ChatMessage, ToolCall } from "../types/agent.js";
import type { ModelFunctionTool } from "../types/tool.js";
import { appConfig } from "./env.js";

interface CompletionInput {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ModelFunctionTool[];
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  thinkingEnabled?: boolean;
}

interface CompletionOutput {
  content: string;
  toolCalls: ToolCall[];
  reasoning_content?: string;
  usageTotalTokens?: number;
}

type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "max" | "xhigh";

class ModelRequestError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ModelRequestError";
  }
}

function toApiMessages(
  systemPrompt: string,
  messages: ChatMessage[],
): ChatCompletionMessageParam[] {
  const apiMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const message of messages) {
    if (message.role === "assistant") {
      apiMessages.push({
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls?.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments,
          },
        })),
        ...(message.reasoning_content
          ? { reasoning_content: message.reasoning_content }
          : {}),
      } as ChatCompletionMessageParam);
    } else if (message.role === "tool") {
      apiMessages.push({
        role: "tool",
        content: message.content || "",
        tool_call_id: message.toolCallId!,
        ...(message.name ? { name: message.name } : {}),
      });
    } else {
      apiMessages.push({
        role: message.role as "user" | "system",
        content: message.content,
      });
    }
  }

  return apiMessages;
}

export class OpenAICompatibleModelAdapter {
  private client: OpenAI;
  private lastRequestAt = 0;

  constructor() {
    this.client = new OpenAI({
      apiKey: appConfig.apiKey,
      baseURL: appConfig.baseUrl,
      maxRetries: 0, // We handle retries manually to maintain enforceRateLimit and custom logic
    });
  }

  private resolveIsDeepSeek(): boolean {
    const modelName = appConfig.model.toLowerCase();
    const baseUrl = appConfig.baseUrl.toLowerCase();
    return modelName.includes("deepseek") || baseUrl.includes("deepseek");
  }

  async completeChat(input: CompletionInput): Promise<CompletionOutput> {
    let lastError: Error | null = null;
    const maxRetries = appConfig.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        await this.enforceRateLimit();
        return await this.requestCompletion(input);
      } catch (error) {
        lastError = error as Error;

        // Handle AbortError or OpenAI specific errors
        const isRetryable = this.isRetryableError(error);

        if (!isRetryable || attempt === maxRetries) {
          throw lastError;
        }

        const delayMs = appConfig.retryBaseDelayMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError ?? new Error("Completion failed");
  }

  private isRetryableError(error: any): boolean {
    if (error instanceof ModelRequestError) return error.retryable;
    if (
      error.name === "AbortError" ||
      error.status === 429 ||
      (error.status && error.status >= 500)
    ) {
      return true;
    }
    return false;
  }

  private async enforceRateLimit(): Promise<void> {
    const minimumIntervalMs = Math.ceil(60_000 / appConfig.rpmLimit);
    const waitMs = this.lastRequestAt + minimumIntervalMs - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.lastRequestAt = Date.now();
  }

  private async requestCompletion(
    input: CompletionInput,
  ): Promise<CompletionOutput> {
    const thinkingEnabled = input.thinkingEnabled ?? appConfig.thinkingEnabled;
    const isDeepSeek = this.resolveIsDeepSeek();
    const messages = toApiMessages(input.systemPrompt, input.messages);

    const tools = input.tools.length > 0 ? input.tools : undefined;

    let reasoningOptions: any = {};
    if (isDeepSeek) {
      reasoningOptions = {
        thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
      };
      if (thinkingEnabled) {
        reasoningOptions.reasoning_effort = appConfig.reasoningEffort;
      }
    } else {
      reasoningOptions = {
        reasoning_effort: thinkingEnabled ? appConfig.reasoningEffort : "low",
      };
    }

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: appConfig.model,
          messages,
          tools,
          stream: true,
          stream_options: { include_usage: true },
          ...reasoningOptions,
        },
        {
          timeout: appConfig.timeoutMs,
        },
      );

      let modelContent = "";
      let reasoningContent = "";
      let usageTotalTokens: number | undefined;
      const toolCallsByIndex = new Map<number, ToolCall>();

      for await (const chunk of stream as unknown as AsyncIterable<ChatCompletionChunk>) {
        if (chunk.usage?.total_tokens) {
          usageTotalTokens = chunk.usage.total_tokens;
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if ("reasoning_content" in delta && delta.reasoning_content) {
          const content = delta.reasoning_content as string;
          reasoningContent += content;
          input.onReasoningDelta?.(content);
        }

        if (delta.content) {
          modelContent += delta.content;
          input.onTextDelta?.(delta.content);
        }

        if (delta.tool_calls) {
          for (const fragment of delta.tool_calls) {
            const index = fragment.index;
            const previous = toolCallsByIndex.get(index) ?? {
              id: fragment.id || `tool-${index}`,
              name: "",
              arguments: "",
            };

            if (fragment.id) previous.id = fragment.id;
            if (fragment.function?.name) previous.name = fragment.function.name;
            if (fragment.function?.arguments)
              previous.arguments += fragment.function.arguments;

            toolCallsByIndex.set(index, previous);
          }
        }
      }

      return {
        content: modelContent,
        reasoning_content: reasoningContent || undefined,
        usageTotalTokens,
        toolCalls: Array.from(toolCallsByIndex.entries())
          .sort(([a], [b]) => a - b)
          .map(([, call]) => ({
            id: call.id,
            name: call.name || "unknown_tool",
            arguments: call.arguments || "{}",
          })),
      };
    } catch (error: any) {
      if (error.name === "AbortError" || error.code === "ETIMEDOUT") {
        throw new ModelRequestError(
          `Request timed out after ${appConfig.timeoutMs}ms.`,
          true,
        );
      }
      throw error;
    }
  }
}
