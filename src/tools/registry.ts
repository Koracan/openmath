import type { ToolCall } from "../types/agent.js";
import type {
  ModelFunctionTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult
} from "../types/tool.js";
import { createMathematicaMcpTools } from "./mathematica-mcp-tool.js";
import { createMarkdownTools } from "./markdown-tool.js";
import { createPythonTool } from "./python-tool.js";

export class ToolRegistry {
  private readonly toolsByName: Map<string, ToolDefinition>;

  constructor(tools: ToolDefinition[]) {
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  static createDefault(): ToolRegistry {
    return new ToolRegistry([
      createPythonTool(),
      ...createMathematicaMcpTools(),
      ...createMarkdownTools()
    ]);
  }

  getModelTools(): ModelFunctionTool[] {
    return [...this.toolsByName.values()].map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  async executeToolCall(
    toolCall: ToolCall,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const tool = this.toolsByName.get(toolCall.name);
    if (!tool) {
      return {
        ok: false,
        summary: `Tool not found: ${toolCall.name}`,
        error: `Tool not found: ${toolCall.name}`
      };
    }

    let parsedArguments: unknown = {};
    try {
      const raw = toolCall.arguments.trim();
      parsedArguments = raw ? JSON.parse(raw) : {};
    } catch (error) {
      return {
        ok: false,
        summary: "Tool argument JSON parsing failed.",
        error: (error as Error).message
      };
    }

    try {
      return await tool.execute(parsedArguments, context);
    } catch (error) {
      return {
        ok: false,
        summary: `Tool ${tool.name} failed at runtime.`,
        error: (error as Error).message
      };
    }
  }
}
