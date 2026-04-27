import React, { type JSX } from "react";
import { Box, Text, useInput } from "ink";

export interface MultilineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isDisabled?: boolean;
}

/**
 * A multiline text input component using Ink's Flex layout.
 *
 * - Each line is rendered as a separate `<Text>` inside a columnar `<Box>`.
 * - Plain Enter submits; Meta/Ctrl+Enter inserts a newline.
 * - A blinking‑style cursor (`_`) appears at the end when enabled.
 */
export function MultilineInput({
  value,
  onChange,
  onSubmit,
  isDisabled = false,
}: MultilineInputProps): JSX.Element {
  useInput((input, key) => {
    if (isDisabled) return;

    // Plain Enter → submit (check first; Enter sends \r, not \n)
    if (key.return && !key.ctrl && !key.meta && !key.shift) {
      onSubmit();
      return;
    }

    // Alt+Enter / Ctrl+Enter → insert newline
    if (key.meta || key.ctrl) {
      if (key.return || input === "\n") {
        onChange(value + "\n");
        return;
      }
    }

    // Backspace
    if (key.backspace || key.delete)  {
      onChange(value.slice(0, -1));
      return;
    }

    // Regular character input
    if (input) {
      onChange(value + input);
    }
  });

  const parts = value.split("\n");
  const head = parts.slice(0, -1);
  const last = parts[parts.length - 1] ?? "";

  return (
    <Box flexDirection="column">
      {head.map((line, i) => (
          <Text>{line || "\u00A0"}</Text>
      ))}
      <Box flexDirection="row">
        <Text>{last}</Text>
        {!isDisabled && <Text dimColor>_</Text>}
      </Box>
    </Box>
  );
}
