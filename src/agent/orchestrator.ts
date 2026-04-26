import { SYSTEM_PROMPT } from "./prompts.js";
import { OpenAICompatibleModelAdapter } from "../config/models.js";
import { SessionManager } from "../session/session-manager.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  printModelPrefix,
  printChunk,
  printInfo,
  printLineBreak,
  printWarn
} from "../io/stream.js";

interface OrchestratorOptions {
  model: OpenAICompatibleModelAdapter;
  sessions: SessionManager;
  tools: ToolRegistry;
  workspaceRoot: string;
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

  async runUserTurn(userInput: string): Promise<void> {
    await this.sessions.addUserMessage(userInput);

    const maxToolRounds = -1; // no limit
    for (let round = 0; maxToolRounds < 0 || round < maxToolRounds; round += 1) {
      let hasPrintedContent = false;

      printModelPrefix();
      const model = await this.model.completeChat({
        systemPrompt: SYSTEM_PROMPT,
        messages: this.sessions.getMessages(),
        tools: this.tools.getModelTools(),
        onTextDelta: (chunk) => {
          hasPrintedContent = true;
          printChunk(chunk);
        }
      });

      if (!hasPrintedContent && model.toolCalls.length > 0) {
        printChunk("(invoking tools)");
      }
      printLineBreak();

      await this.sessions.addModelMessage(
        model.content,
        model.toolCalls.length > 0 ? model.toolCalls : undefined,
        model.reasoning_content
      );

      if (model.toolCalls.length === 0) {
        return;
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
    }

    printWarn("Tool call loop reached max rounds for this turn.");
  }
}
