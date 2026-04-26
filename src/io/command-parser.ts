export type ParsedCommand =
  | { type: "new"; title?: string }
  | { type: "list" }
  | { type: "switch"; sessionId: string }
  | { type: "history"; limit: number }
  | { type: "help" }
  | { type: "exit" }
  | { type: "unknown"; raw: string };

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [command, ...rest] = trimmed.slice(1).split(/\s+/);

  switch (command) {
    case "new": {
      const title = rest.join(" ").trim();
      return title ? { type: "new", title } : { type: "new" };
    }
    case "list":
      return { type: "list" };
    case "switch": {
      const sessionId = rest[0];
      if (!sessionId) {
        return { type: "unknown", raw: "/switch <id>" };
      }
      return { type: "switch", sessionId };
    }
    case "history": {
      const parsed = Number(rest[0] ?? "20");
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
      return { type: "history", limit };
    }
    case "help":
      return { type: "help" };
    case "exit":
      return { type: "exit" };
    default:
      return { type: "unknown", raw: trimmed };
  }
}
