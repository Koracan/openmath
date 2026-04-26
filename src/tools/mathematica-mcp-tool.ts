import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appConfig } from "../config/env.js";
import type { ToolDefinition, ToolExecutionResult } from "../types/tool.js";
import { z } from "zod";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpToolDescriptor {
  name?: unknown;
}

interface McpToolsListResult {
  tools?: McpToolDescriptor[];
  nextCursor?: unknown;
}

interface McpToolCallResult {
  isError?: unknown;
  content?: unknown;
  structuredContent?: unknown;
}

interface TextToolContent {
  type: "text";
  text: string;
}

interface ImageToolContent {
  type: "image";
  data: string;
  mimeType?: string;
}

interface ToolCache {
  tools: string[];
  expiresAt: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...<truncated>`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeConnectionError(message: string, details?: string): Error {
  return new Error(details ? `${message}. ${details}` : message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTextContents(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const texts: string[] = [];
  for (const item of content) {
    const candidate = item as Partial<TextToolContent>;
    if (candidate?.type === "text" && typeof candidate.text === "string") {
      texts.push(candidate.text);
    }
  }
  return texts;
}

function parseImageContents(content: unknown): ImageToolContent[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const images: ImageToolContent[] = [];
  for (const item of content) {
    const candidate = item as Partial<ImageToolContent>;
    if (candidate?.type !== "image") {
      continue;
    }
    if (typeof candidate.data !== "string") {
      continue;
    }
    images.push({
      type: "image",
      data: candidate.data,
      mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : undefined
    });
  }
  return images;
}

class MathematicaMcpClient {
  private readonly transport = appConfig.mmaMcpTransport;
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private connectPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readBuffer = Buffer.alloc(0);
  private pendingRequests = new Map<number, PendingRequest>();
  private toolCache: ToolCache | null = null;
  private stderrTail: string[] = [];
  private httpSessionId: string | null = null;

  async callToolWithReconnect(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    try {
      return await this.callTool(name, args);
    } catch (error) {
      if (!this.isRecoverableTransportError(error)) {
        throw error;
      }
      await this.reconnect();
      return this.callTool(name, args);
    }
  }

  async healthCheck(): Promise<{ tools: string[]; pid: number | null }> {
    await this.ensureConnected();
    const tools = await this.listTools(true);
    return {
      tools,
      pid: this.child?.pid ?? null
    };
  }

  async listTools(forceRefresh = false): Promise<string[]> {
    await this.ensureConnected();

    const now = Date.now();
    if (!forceRefresh && this.toolCache && this.toolCache.expiresAt > now) {
      return this.toolCache.tools;
    }

    let cursor: string | undefined;
    const discovered: string[] = [];

    do {
      const params = cursor ? { cursor } : {};
      const result = (await this.sendRequest(
        "tools/list",
        params,
        appConfig.mmaMcpTimeoutMs
      )) as McpToolsListResult;

      const tools = Array.isArray(result.tools) ? result.tools : [];
      for (const item of tools) {
        if (typeof item.name === "string") {
          discovered.push(item.name);
        }
      }

      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor);

    const uniqueTools = [...new Set(discovered)].sort((a, b) => a.localeCompare(b));
    this.toolCache = {
      tools: uniqueTools,
      expiresAt: Date.now() + appConfig.mmaMcpToolCacheTtlMs
    };

    return uniqueTools;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    await this.ensureConnected();
    const tools = await this.listTools();
    if (!tools.includes(name)) {
      throw makeConnectionError(
        `MCP tool not found: ${name}`,
        `Discovered tools: ${tools.join(", ") || "(none)"}`
      );
    }

    const result = (await this.sendRequest(
      "tools/call",
      { name, arguments: args },
      appConfig.mmaMcpTimeoutMs
    )) as McpToolCallResult;

    return result;
  }

  private async ensureConnected(): Promise<void> {
    if (this.initialized && this.child && this.child.exitCode === null) {
      return;
    }

    if (!appConfig.mmaMcpEnabled) {
      throw makeConnectionError("Mathematica MCP is disabled by OPENMATH_MMA_MCP_ENABLED");
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connectInternal();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async reconnect(): Promise<void> {
    await this.dispose();
    await this.ensureConnected();
  }

  private async connectInternal(): Promise<void> {
    await this.dispose();

    const baseArgs = ["--directory", appConfig.mmaMcpProjectDir, "run", "mma-mcp", "serve"];

    if (this.transport === "http") {
      baseArgs.push(
        "--transport",
        "http",
        "--host",
        appConfig.mmaMcpHttpHost,
        "--port",
        String(appConfig.mmaMcpHttpPort)
      );
    } else {
      baseArgs.push("--transport", "stdio");
    }

    baseArgs.push(...appConfig.mmaMcpExtraArgs);

    this.child = spawn(appConfig.mmaMcpCommand, baseArgs, {
      cwd: appConfig.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
      this.consumeFrames();
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      this.stderrTail.push(...lines);
      if (this.stderrTail.length > 12) {
        this.stderrTail.splice(0, this.stderrTail.length - 12);
      }
    });

    this.child.once("error", (error) => {
      this.failAllPending(makeConnectionError("MCP process failed to start", error.message));
      this.initialized = false;
      this.child = null;
    });

    this.child.once("exit", (code, signal) => {
      const details = `exitCode=${code ?? "null"}, signal=${signal ?? "null"}`;
      this.failAllPending(makeConnectionError("MCP process exited", details));
      this.initialized = false;
      this.child = null;
      this.toolCache = null;
    });

    try {
      await this.initializeMcp();
      this.initialized = true;
      await this.listTools(true);
    } catch (error) {
      const stderrDetails = this.stderrTail.join(" | ");
      await this.dispose();
      throw makeConnectionError(
        "Failed to initialize Mathematica MCP connection",
        stderrDetails || toErrorMessage(error)
      );
    }
  }

  private sendNotification(method: string, params?: unknown): void {
    if (this.transport === "http") {
      void this.sendHttpNotification(method, params);
      return;
    }

    const payload = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {})
    };
    this.writeFrame(payload);
  }

  private async sendRequest(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    if (this.transport === "http") {
      return this.sendHttpRequest(method, params, timeoutMs);
    }

    return this.sendStdioRequest(method, params, timeoutMs);
  }

  private async sendStdioRequest(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    if (!this.child || this.child.exitCode !== null) {
      throw makeConnectionError("MCP process is not running");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(makeConnectionError(`MCP request timed out for method ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.writeFrame(request);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(makeConnectionError("Failed to send MCP request", toErrorMessage(error)));
      }
    });
  }

  private async sendHttpNotification(method: string, params?: unknown): Promise<void> {
    try {
      await this.sendHttpRequest(method, params ?? {}, appConfig.mmaMcpTimeoutMs, true);
    } catch {
      // Notifications are best-effort and should not block tool execution.
    }
  }

  private getHttpUrl(): string {
    return `http://${appConfig.mmaMcpHttpHost}:${appConfig.mmaMcpHttpPort}/mcp`;
  }

  private parseHttpResponse(body: string): JsonRpcResponse {
    const trimmed = body.trim();
    if (!trimmed) {
      throw makeConnectionError("Empty HTTP response from MCP server");
    }

    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed) as JsonRpcResponse;
    }

    const lines = trimmed.split(/\r?\n/);
    const events: string[] = [];
    let eventData: string[] = [];

    for (const line of lines) {
      if (line.startsWith("data:")) {
        eventData.push(line.slice(5).trimStart());
        continue;
      }

      if (line.trim().length === 0 && eventData.length > 0) {
        events.push(eventData.join("\n"));
        eventData = [];
      }
    }

    if (eventData.length > 0) {
      events.push(eventData.join("\n"));
    }

    for (const event of events) {
      try {
        return JSON.parse(event) as JsonRpcResponse;
      } catch {
        continue;
      }
    }

    throw makeConnectionError("Unable to parse MCP SSE response payload");
  }

  private async sendHttpRequest(
    method: string,
    params: unknown,
    timeoutMs: number,
    isNotification = false
  ): Promise<unknown> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      };

      if (this.httpSessionId) {
        headers["mcp-session-id"] = this.httpSessionId;
      }

      const payload = isNotification
        ? {
            jsonrpc: "2.0",
            method,
            ...(params !== undefined ? { params } : {})
          }
        : {
            jsonrpc: "2.0",
            id,
            method,
            params
          };

      const response = await fetch(this.getHttpUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw makeConnectionError(
          `MCP HTTP request failed with status ${response.status}`,
          body.slice(0, 500)
        );
      }

      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) {
        this.httpSessionId = sessionId;
      }

      if (isNotification) {
        return null;
      }

      const body = await response.text();
      const parsed = this.parseHttpResponse(body);
      if (parsed.error) {
        throw makeConnectionError(
          `MCP request failed with code ${parsed.error.code}`,
          parsed.error.message
        );
      }
      return parsed.result;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw makeConnectionError(`MCP HTTP request timed out for method ${method}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async initializeMcp(): Promise<void> {
    const initializePayload = {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "openmath",
        version: "0.0.1"
      }
    };

    const startedAt = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - startedAt < appConfig.mmaMcpTimeoutMs) {
      try {
        await this.sendRequest("initialize", initializePayload, appConfig.mmaMcpTimeoutMs);
        this.sendNotification("notifications/initialized", {});
        return;
      } catch (error) {
        lastError = error as Error;
        await sleep(250);
      }
    }

    throw makeConnectionError(
      "MCP initialize timeout",
      lastError?.message ?? "No detailed error"
    );
  }

  private writeFrame(payload: object): void {
    if (!this.child || this.child.stdin.destroyed || this.child.exitCode !== null) {
      throw makeConnectionError("MCP stdin is unavailable");
    }

    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  private consumeFrames(): void {
    while (true) {
      const headerEnd = this.readBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const rawHeader = this.readBuffer.slice(0, headerEnd).toString("utf8");
      const match = rawHeader.match(/content-length\s*:\s*(\d+)/i);
      if (!match?.[1]) {
        this.readBuffer = this.readBuffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(match[1], 10);
      const frameEnd = headerEnd + 4 + contentLength;
      if (this.readBuffer.length < frameEnd) {
        return;
      }

      const body = this.readBuffer.slice(headerEnd + 4, frameEnd).toString("utf8");
      this.readBuffer = this.readBuffer.slice(frameEnd);

      try {
        const payload = JSON.parse(body) as JsonRpcResponse;
        this.handleResponse(payload);
      } catch {
        continue;
      }
    }
  }

  private handleResponse(payload: JsonRpcResponse): void {
    if (typeof payload.id !== "number") {
      return;
    }

    const pending = this.pendingRequests.get(payload.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(payload.id);

    if (payload.error) {
      pending.reject(
        makeConnectionError(
          `MCP request failed with code ${payload.error.code}`,
          payload.error.message
        )
      );
      return;
    }

    pending.resolve(payload.result);
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private isRecoverableTransportError(error: unknown): boolean {
    const message = toErrorMessage(error).toLowerCase();
    return (
      message.includes("not running") ||
      message.includes("stdin") ||
      message.includes("timed out") ||
      message.includes("process exited") ||
      message.includes("failed to initialize")
    );
  }

  private async dispose(): Promise<void> {
    this.initialized = false;
    this.toolCache = null;
    this.readBuffer = Buffer.alloc(0);
    this.httpSessionId = null;

    const existing = this.child;
    this.child = null;

    if (!existing) {
      return;
    }

    this.failAllPending(makeConnectionError("MCP connection was reset"));

    if (existing.exitCode === null) {
      existing.kill();
    }
  }
}

const evaluateArgsSchema = z.object({
  expression: z.string().min(1),
  form: z.string().optional()
});

const evaluateImageArgsSchema = z.object({
  expression: z.string().min(1)
});

const healthArgsSchema = z.object({}).strict();

const sharedClient = new MathematicaMcpClient();

function formatToolError(error: unknown): ToolExecutionResult {
  return {
    ok: false,
    summary: "Mathematica MCP tool call failed.",
    error: toErrorMessage(error)
  };
}

export function createMathematicaMcpTools(): ToolDefinition[] {
  return [
    {
      name: "mathematica_evaluate",
      description:
        "Evaluate Wolfram Language expression through mma-mcp and return text result (symbolic algebra/calculus).",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "Wolfram Language expression to evaluate."
          },
          form: {
            type: "string",
            description: "Optional output form such as TeXForm, InputForm, TraditionalForm."
          }
        },
        required: ["expression"],
        additionalProperties: false
      },
      execute: async (args): Promise<ToolExecutionResult> => {
        const parsed = evaluateArgsSchema.safeParse(args);
        if (!parsed.success) {
          return {
            ok: false,
            summary: "Invalid arguments for mathematica_evaluate.",
            error: parsed.error.message
          };
        }

        try {
          const result = await sharedClient.callToolWithReconnect("evaluate", {
            expression: parsed.data.expression,
            form: parsed.data.form ?? ""
          });

          if (result.isError === true) {
            const text = parseTextContents(result.content).join("\n");
            return {
              ok: false,
              summary: "Mathematica evaluate returned an error.",
              error: text || "MCP tool returned isError=true."
            };
          }

          const text = parseTextContents(result.content).join("\n");
          const fallbackText =
            text ||
            (result.structuredContent
              ? JSON.stringify(result.structuredContent)
              : "(no textual output)");

          return {
            ok: true,
            summary: "Mathematica evaluation succeeded.",
            data: {
              output: truncateText(fallbackText, appConfig.mmaMcpMaxTextChars)
            }
          };
        } catch (error) {
          return formatToolError(error);
        }
      }
    },
    {
      name: "mathematica_evaluate_image",
      description:
        "Evaluate Wolfram Language graphics expression through mma-mcp and return PNG image (base64).",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "Wolfram Language expression that produces a plot/graphic."
          }
        },
        required: ["expression"],
        additionalProperties: false
      },
      execute: async (args): Promise<ToolExecutionResult> => {
        const parsed = evaluateImageArgsSchema.safeParse(args);
        if (!parsed.success) {
          return {
            ok: false,
            summary: "Invalid arguments for mathematica_evaluate_image.",
            error: parsed.error.message
          };
        }

        try {
          const result = await sharedClient.callToolWithReconnect("evaluate_image", {
            expression: parsed.data.expression
          });

          if (result.isError === true) {
            const text = parseTextContents(result.content).join("\n");
            return {
              ok: false,
              summary: "Mathematica evaluate_image returned an error.",
              error: text || "MCP tool returned isError=true."
            };
          }

          const images = parseImageContents(result.content);
          const first = images[0];
          if (!first) {
            return {
              ok: false,
              summary: "Mathematica evaluate_image returned no image.",
              error: "No image content found in MCP response."
            };
          }

          return {
            ok: true,
            summary: "Mathematica image evaluation succeeded.",
            data: {
              imageBase64: first.data,
              mimeType: first.mimeType ?? "image/png"
            }
          };
        } catch (error) {
          return formatToolError(error);
        }
      }
    },
    {
      name: "mathematica_mcp_health_check",
      description:
        "Check mma-mcp server connectivity, discovered tools, and auto-reconnect status.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      execute: async (args): Promise<ToolExecutionResult> => {
        const parsed = healthArgsSchema.safeParse(args);
        if (!parsed.success) {
          return {
            ok: false,
            summary: "Invalid arguments for mathematica_mcp_health_check.",
            error: parsed.error.message
          };
        }

        try {
          const status = await sharedClient.healthCheck();
          return {
            ok: true,
            summary: `Mathematica MCP healthy. tools=${status.tools.length}`,
            data: status
          };
        } catch (error) {
          return formatToolError(error);
        }
      }
    }
  ];
}
