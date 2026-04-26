declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  export interface TerminalRendererOptions {
    [key: string]: unknown;
  }

  export function markedTerminal(
    options?: TerminalRendererOptions,
    highlightOptions?: Record<string, unknown>
  ): MarkedExtension;

  const TerminalRenderer: unknown;
  export default TerminalRenderer;
}
