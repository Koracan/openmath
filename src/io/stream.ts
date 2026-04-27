const ANSI_RESET = "\u001b[0m";
const ANSI_USER_COLOR = "\u001b[38;5;45m";

function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY);
}

function colorize(
  text: string,
  colorCode: string,
  keepColorAfterInnerReset = false
): string {
  if (!supportsColor() || text.length === 0) {
    return text;
  }

  if (!keepColorAfterInnerReset) {
    return `${colorCode}${text}${ANSI_RESET}`;
  }

  const recolored = text.replaceAll(ANSI_RESET, `${ANSI_RESET}${colorCode}`);
  return `${colorCode}${recolored}${ANSI_RESET}`;
}

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

export function resetTerminalStyle(): void {
  if (supportsColor()) {
    process.stdout.write(ANSI_RESET);
  }
}

export function colorizeUserLabel(label: string): string {
  return colorize(label, ANSI_USER_COLOR);
}

export function colorizeUserMessageBody(text: string): string {
  return colorize(text, ANSI_USER_COLOR, true);
}

export function makePrompt(title: string): string {
  const prompt = `[user] openmath:${title}> `;
  if (!supportsColor()) {
    return prompt;
  }

  // Keep user input in the same color; caller resets after readline returns.
  return `${ANSI_USER_COLOR}${prompt}`;
}
