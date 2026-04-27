import type { ChatMessage, ToolCall } from "../types/agent.js";
import type { ModelFunctionTool } from "../types/tool.js";
import { appConfig } from "./env.js";

interface CompletionInput {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ModelFunctionTool[];
  onTextDelta?: (chunk: string) => void;
}

interface CompletionOutput {
  content: string;
  toolCalls: ToolCall[];
  reasoning_content?: string;
  usageTotalTokens?: number;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    total_tokens?: number;
  };
}

interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

class ModelRequestError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = "ModelRequestError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toApiMessage(message: ChatMessage): ApiMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      reasoning_content: message.reasoning_content ?? null,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments
        }
      }))
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      name: message.name,
      tool_call_id: message.toolCallId
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

export class OpenAICompatibleModelAdapter {
  private lastRequestAt = 0;

  async completeChat(input: CompletionInput): Promise<CompletionOutput> {
    await this.enforceRateLimit();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= appConfig.maxRetries; attempt += 1) {
      try {
        return await this.requestCompletion(input);
      } catch (error) {
        lastError = error as Error;
        const retryable =
          error instanceof ModelRequestError ? error.retryable : true;

        if (!retryable || attempt === appConfig.maxRetries) {
          throw lastError;
        }

        const delayMs = appConfig.retryBaseDelayMs * 2 ** attempt;
        await sleep(delayMs);
      }
    }

    throw lastError ?? new Error("Completion failed without an explicit error.");
  }

  private async enforceRateLimit(): Promise<void> {
    const minimumIntervalMs = Math.ceil(60_000 / appConfig.rpmLimit);
    const waitMs = this.lastRequestAt + minimumIntervalMs - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastRequestAt = Date.now();
  }

  private async requestCompletion(input: CompletionInput): Promise<CompletionOutput> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), appConfig.timeoutMs);

    try {
      const messages: ApiMessage[] = [
        { role: "system", content: input.systemPrompt },
        ...input.messages.map(toApiMessage)
      ];

      const response = await fetch(`${appConfig.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${appConfig.apiKey}`
        },
        body: JSON.stringify({
          model: appConfig.model,
          stream: true,
          stream_options: { include_usage: true },
          messages,
          tools: input.tools.length > 0 ? input.tools : undefined,
          ...(appConfig.thinkingEnabled && {
            reasoning_effort: appConfig.reasoningEffort,
            extra_body: { thinking: { type: "enabled" } }
          })
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        throw new ModelRequestError(
          `LLM request failed with status ${response.status}: ${body.slice(0, 300)}`,
          retryable
        );
      }

      if (!response.body) {
        throw new ModelRequestError("Response body is empty.", true);
      }

      return await this.readStreamingResponse(response.body, input.onTextDelta);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new ModelRequestError(
          `Request timed out after ${appConfig.timeoutMs}ms.`,
          true
        );
      }
      if (error instanceof ModelRequestError) {
        throw error;
      }
      throw new ModelRequestError(
        `Network or parsing error: ${(error as Error).message}`,
        true
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readStreamingResponse(
    body: ReadableStream<Uint8Array>,
    onTextDelta?: (chunk: string) => void
  ): Promise<CompletionOutput> {
    const reader = body.getReader();
    const decoder = new TextDecoder();

    let textBuffer = "";
    let modelContent = "";
    let reasoningContent = "";
    let usageTotalTokens: number | undefined;
    const toolCallsByIndex = new Map<number, ToolCall>();

    const consumeLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        return false;
      }

      const payloadText = trimmed.slice(5).trim();
      if (!payloadText) {
        return false;
      }

      if (payloadText === "[DONE]") {
        return true;
      }

      let payload: StreamChunk;
      try {
        payload = JSON.parse(payloadText) as StreamChunk;
      } catch {
        return false;
      }

      if (typeof payload.usage?.total_tokens === "number") {
        usageTotalTokens = payload.usage.total_tokens;
      }

      const delta = payload.choices?.[0]?.delta;
      if (!delta) {
        return false;
      }

      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        reasoningContent += delta.reasoning_content;
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        modelContent += delta.content;
        onTextDelta?.(delta.content);
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          const index = fragment.index;
          const previous = toolCallsByIndex.get(index) ?? {
            id: `tool-${index}`,
            name: "",
            arguments: ""
          };

          if (fragment.id) {
            previous.id = fragment.id;
          }
          if (fragment.function?.name) {
            previous.name = fragment.function.name;
          }
          if (fragment.function?.arguments) {
            previous.arguments += fragment.function.arguments;
          }

          toolCallsByIndex.set(index, previous);
        }
      }

      return false;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      textBuffer += decoder.decode(value, { stream: true });
      let lineBreak = textBuffer.indexOf("\n");

      while (lineBreak !== -1) {
        const line = textBuffer.slice(0, lineBreak);
        textBuffer = textBuffer.slice(lineBreak + 1);
        const doneSignal = consumeLine(line);
        if (doneSignal) {
          return {
            content: modelContent,
            reasoning_content: reasoningContent || undefined,
            usageTotalTokens,
            toolCalls: [...toolCallsByIndex.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, call]) => ({
                id: call.id,
                name: call.name || "unknown_tool",
                arguments: call.arguments || "{}"
              }))
          };
        }
        lineBreak = textBuffer.indexOf("\n");
      }
    }

    if (textBuffer.trim()) {
      consumeLine(textBuffer);
    }

    return {
      content: modelContent,
      reasoning_content: reasoningContent || undefined,
      usageTotalTokens,
      toolCalls: [...toolCallsByIndex.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({
          id: call.id,
          name: call.name || "unknown_tool",
          arguments: call.arguments || "{}"
        }))
    };
  }
}
