import { GoogleGenAI } from "@google/genai";
import { Content, Part, ThinkingLevel } from "@google/genai";
import type { ChatMessage, ToolCall } from "../../types/agent.js";
import type { ModelFunctionTool } from "../../types/tool.js";
import { appConfig } from "../env.js";
import type {
  CompletionInput,
  CompletionOutput,
  ModelAdapter,
} from "../models.js";
import { ModelRequestError } from "./errors.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const toGeminiThinkingLevel = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
};

/**
 * Convert system prompt + ChatMessage[] to Gemini contents format.
 *
 * When a message carries `providerMetadata.geminiParts`, those raw parts are
 * used verbatim — this preserves `thought_signature` and other Gemini‑internal
 * fields that would be lost in a plain‑text round‑trip.
 */
function toGeminiInput(
  systemPrompt: string,
  messages: ChatMessage[],
): { contents: Content[]; systemInstruction: Content } {
  const systemInstruction: Content = {
    role: "user",
    parts: [{ text: systemPrompt } as Part],
  };

  const contents: Content[] = [];

  for (const msg of messages) {
    // ── Stored raw parts available → use verbatim ──
    const geminiParts = (
      msg.providerMetadata as { geminiParts?: Part[] } | undefined
    )?.geminiParts;

    if (geminiParts?.length) {
      contents.push({
        role: msg.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: geminiParts,
      });
      continue;
    }

    // ── Fallback: reconstruct from standard fields ──
    if (msg.role === "assistant") {
      const parts: Part[] = [];

      if (msg.content) {
        parts.push({ text: msg.content } as Part);
      }

      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          parts.push({
            functionCall: {
              id: tc.id,
              name: tc.name,
              args: safeJsonParse(tc.arguments) as
                | Record<string, unknown>
                | undefined,
            },
          } as Part);
        }
      }

      contents.push({ role: "model", parts });
    } else if (msg.role === "tool") {
      // Gemini expects tool responses as 'user'-role functionResponse parts
      const toolCallId =
        (msg as any).toolCallId || (msg as any).tool_call_id || (msg as any).id;

      const functionResponse: Record<string, unknown> = {
        name: msg.name ?? "unknown",
        response: safeJsonParse(msg.content) as
          | Record<string, unknown>
          | undefined,
      };

      // 必须加上 ID 才能匹配
      if (toolCallId) {
        functionResponse.id = toolCallId;
      }
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse,
          } as Part,
        ],
      });
    } else {
      // user / fallback
      contents.push({
        role: "user",
        parts: [{ text: msg.content } as Part],
      });
    }
  }

  return { contents, systemInstruction };
}

/** Parse JSON safely — returns a best-effort object. */
function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { text: raw };
  }
}

/**
 * Convert our ModelFunctionTool[] to Gemini tool declarations.
 *
 * Gemini wraps each function in `functionDeclarations` inside a `Tool` object.
 */
function toGeminiTools(tools: ModelFunctionTool[]): unknown[] {
  if (tools.length === 0) return [];

  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    },
  ];
}

/**
 * Accumulate a raw Part into the parts array, merging consecutive plain‑text
 * parts of the same type (thought / not‑thought) to keep the history compact.
 * Parts carrying `thought_signature` or `functionCall` are kept separate.
 */
function accumulatePart(parts: Part[], newPart: Part): void {
  const last = parts[parts.length - 1];

  const newText = "text" in newPart ? (newPart as any).text : undefined;
  const lastText = last && "text" in last ? (last as any).text : undefined;
  const newThought =
    "thought" in newPart ? (newPart as any).thought : undefined;
  const lastThought =
    last && "thought" in last ? (last as any).thought : undefined;
  const newSignature =
    "thought_signature" in newPart
      ? (newPart as any).thought_signature
      : undefined;
  const lastSignature =
    last && "thought_signature" in last
      ? (last as any).thought_signature
      : undefined;
  const newFnCall =
    "functionCall" in newPart ? (newPart as any).functionCall : undefined;
  const lastFnCall =
    last && "functionCall" in last ? (last as any).functionCall : undefined;

  const canMerge =
    last &&
    newText !== undefined &&
    lastText !== undefined &&
    Boolean(newThought) === Boolean(lastThought) &&
    !newSignature &&
    !lastSignature &&
    !newFnCall &&
    !lastFnCall;

  if (canMerge) {
    (last as any).text += newText;
  } else {
    parts.push(JSON.parse(JSON.stringify(newPart)));
  }
}

// ---------------------------------------------------------------------------
// Google GenAI adapter
// ---------------------------------------------------------------------------

export class GoogleGenaiModelAdapter implements ModelAdapter {
  private client: GoogleGenAI;
  private lastRequestAt = 0;

  constructor() {
    this.client = new GoogleGenAI({ apiKey: appConfig.apiKey });
  }

  // -----------------------------------------------------------------------
  // ModelAdapter contract
  // -----------------------------------------------------------------------

  async completeChat(input: CompletionInput): Promise<CompletionOutput> {
    let lastError: Error | null = null;
    const maxRetries = appConfig.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        await this.enforceRateLimit();
        return await this.requestCompletion(input);
      } catch (error) {
        lastError = error as Error;

        if (!this.isRetryableError(error) || attempt === maxRetries) {
          throw lastError;
        }

        const delayMs = appConfig.retryBaseDelayMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError ?? new Error("Completion failed");
  }

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  private async enforceRateLimit(): Promise<void> {
    const minimumIntervalMs = Math.ceil(60_000 / appConfig.rpmLimit);
    const waitMs = this.lastRequestAt + minimumIntervalMs - Date.now();

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.lastRequestAt = Date.now();
  }

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  private isRetryableError(error: unknown): boolean {
    if (error instanceof ModelRequestError) return error.retryable;

    if (error instanceof Error) {
      const err = error as Error & { status?: number; name: string };

      if (err.name === "AbortError") return true;
      if (err.status === 429) return true;
      if (err.status !== undefined && err.status >= 500) return true;
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Single completion request
  // -----------------------------------------------------------------------

  private async requestCompletion(
    input: CompletionInput,
  ): Promise<CompletionOutput> {
    const thinkingEnabled = input.thinkingEnabled ?? appConfig.thinkingEnabled;
    const thinkingLevel = thinkingEnabled
      ? toGeminiThinkingLevel[appConfig.reasoningEffort]
      : ThinkingLevel.MINIMAL;

    const { contents, systemInstruction } = toGeminiInput(
      input.systemPrompt,
      input.messages,
    );

    const tools = toGeminiTools(input.tools);

    try {
      const stream = await this.client.models.generateContentStream({
        model: appConfig.model,
        contents,
        config: {
          systemInstruction,
          tools: tools.length > 0 ? (tools as any) : undefined,
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: thinkingLevel,
          },
        },
      });

      let modelContent = "";
      let reasoningContent = "";
      let usageTotalTokens: number | undefined;
      const rawParts: Part[] = [];

      for await (const chunk of stream) {
        // Collect usage metadata
        if (chunk.usageMetadata?.totalTokenCount) {
          usageTotalTokens = chunk.usageMetadata.totalTokenCount;
        }

        const parts: Part[] = chunk.candidates?.[0]?.content?.parts ?? [];

        for (const part of parts) {
          const text = "text" in part ? (part as any).text : undefined;
          const thought = "thought" in part ? (part as any).thought : undefined;
          const functionCall =
            "functionCall" in part ? (part as any).functionCall : undefined;

          // ── Stream text / thought to caller ──
          if (text !== undefined) {
            if (thought) {
              reasoningContent += text;
              input.onReasoningDelta?.(text);
            } else {
              modelContent += text;
              input.onTextDelta?.(text);
            }
          } else if (functionCall) {
            // No streaming for function calls — they show up as a single part
          }

          // ── Accumulate raw part for history storage ──
          accumulatePart(rawParts, part);
        }
      }

      // ── Extract tool calls from raw parts ──
      const functionCalls = rawParts
        .filter((p): boolean => "functionCall" in p)
        .map((p) => (p as any).functionCall);

      const toolCalls: ToolCall[] = functionCalls.map(
        (
          fc: { id?: string; name: string; args?: Record<string, unknown> },
          index: number,
        ) => ({
          id: fc.id ?? `gemini-fc-${index}`,
          name: fc.name ?? "unknown_tool",
          arguments: JSON.stringify(fc.args ?? {}),
        }),
      );

      // ── Build output ──
      const output: CompletionOutput = {
        content: modelContent,
        reasoning_content: reasoningContent || undefined,
        usageTotalTokens,
        toolCalls,
      };

      // Attach raw parts for round-trip fidelity (Fat Schema)
      if (rawParts.length > 0) {
        output.providerMetadata = { geminiParts: rawParts };
      }

      return output;
    } catch (error) {
      const err = error as Error & { name: string; code?: string };

      if (err.name === "AbortError" || err.code === "ETIMEDOUT") {
        throw new ModelRequestError(
          `Request timed out after ${appConfig.timeoutMs}ms.`,
          true,
        );
      }

      throw error;
    }
  }
}
