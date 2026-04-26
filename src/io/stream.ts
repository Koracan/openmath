export function printInfo(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function printWarn(message: string): void {
  process.stdout.write(`[warn] ${message}\n`);
}

export function printError(message: string): void {
  process.stdout.write(`[error] ${message}\n`);
}

export function printModelPrefix(): void {
  process.stdout.write("model> ");
}

export function printChunk(text: string): void {
  process.stdout.write(text);
}

export function printLineBreak(): void {
  process.stdout.write("\n");
}

export function makePrompt(sessionId: string): string {
  return `openmath:${sessionId.slice(0, 8)}> `;
}
