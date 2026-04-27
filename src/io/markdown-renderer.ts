import katex from "katex";

const blockMathDollarPattern = /\$\$([\s\S]+?)\$\$/g;
const blockMathBracketPattern = /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g;
const inlineMathDollarPattern = /(?<!\\)\$([^\n$]+?)\$/g;
const inlineMathParenPattern = /(?<!\\)\\\((.+?)(?<!\\)\\\)/g;
const fencedCodePattern = /(```[\s\S]*?```)/g;

const streamParagraphBoundaryPattern = /\n\s*\n+/g;
const streamLineBoundaryPattern = /\n/g;
const streamSentenceBoundaryPattern = /[。！？!?；;:：]\s+/g;

const codeFenceDelimiterPattern = /^[ \t]{0,3}```/gm;
const closedCodeFencePattern = /^[ \t]{0,3}```[\s\S]*?^[ \t]{0,3}```[ \t]*\n?/gm;
const unescapedDoubleDollarPattern = /(?<!\\)\$\$/g;
const closedDollarMathBlockPattern = /(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$/g;
const blockMathBracketOpenPattern = /(?<!\\)\\\[/g;
const blockMathBracketClosePattern = /(?<!\\)\\\]/g;
const inlineMathParenOpenPattern = /(?<!\\)\\\(/g;
const inlineMathParenClosePattern = /(?<!\\)\\\)/g;
const unescapedBacktickPattern = /(?<!\\)`/g;
const unescapedDollarPattern = /(?<!\\)\$/g;

const STREAM_MIN_CHARS_FOR_LINE_FLUSH = 24;
const STREAM_MIN_CHARS_FOR_SENTENCE_FLUSH = 56;
const STREAM_FORCE_FLUSH_CHARS = 220;
const STREAM_HARD_FLUSH_CHARS = 480;

const htmlEntityMap: Record<string, string> = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: " ",
  ThinSpace: " ",
  InvisibleTimes: "x",
  PlusMinus: "+-",
  MinusPlus: "-+",
  CenterDot: ".",
  le: "<=",
  ge: ">=",
  ne: "!="
};

function countMatches(source: string, pattern: RegExp): number {
  const matches = source.match(pattern);
  return matches ? matches.length : 0;
}

function addBoundaryCandidates(
  source: string,
  pattern: RegExp,
  candidates: Set<number>
): void {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const iterator = new RegExp(pattern.source, flags);

  let match = iterator.exec(source);
  while (match) {
    if (typeof match.index === "number") {
      candidates.add(match.index + match[0].length);
    }

    match = iterator.exec(source);
  }
}

function findLastWhitespaceBoundary(source: string): number {
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const char = source[index];
    if (char && /\s/.test(char)) {
      return index + 1;
    }
  }

  return 0;
}

function isBalancedMarkdownPrefix(prefix: string): boolean {
  if (countMatches(prefix, codeFenceDelimiterPattern) % 2 === 1) {
    return false;
  }

  if (countMatches(prefix, unescapedDoubleDollarPattern) % 2 === 1) {
    return false;
  }

  if (
    countMatches(prefix, blockMathBracketOpenPattern) !==
    countMatches(prefix, blockMathBracketClosePattern)
  ) {
    return false;
  }

  if (
    countMatches(prefix, inlineMathParenOpenPattern) !==
    countMatches(prefix, inlineMathParenClosePattern)
  ) {
    return false;
  }

  const withoutCodeFences = prefix.replace(closedCodeFencePattern, "");
  const withoutBlockMath = withoutCodeFences.replace(closedDollarMathBlockPattern, "");

  if (countMatches(withoutBlockMath, unescapedBacktickPattern) % 2 === 1) {
    return false;
  }

  if (countMatches(withoutBlockMath, unescapedDollarPattern) % 2 === 1) {
    return false;
  }

  return true;
}

function findStreamFlushBoundary(buffer: string): number {
  if (!buffer) {
    return 0;
  }

  const candidates = new Set<number>();
  addBoundaryCandidates(buffer, streamParagraphBoundaryPattern, candidates);

  if (buffer.length >= STREAM_MIN_CHARS_FOR_LINE_FLUSH) {
    addBoundaryCandidates(buffer, streamLineBoundaryPattern, candidates);
  }

  if (buffer.length >= STREAM_MIN_CHARS_FOR_SENTENCE_FLUSH) {
    addBoundaryCandidates(buffer, streamSentenceBoundaryPattern, candidates);
  }

  if (buffer.length >= STREAM_FORCE_FLUSH_CHARS) {
    const whitespaceBoundary = findLastWhitespaceBoundary(buffer);
    if (whitespaceBoundary > 0) {
      candidates.add(whitespaceBoundary);
    }
  }

  const ordered = [...candidates].sort((left, right) => right - left);
  for (const candidate of ordered) {
    if (candidate <= 0 || candidate > buffer.length) {
      continue;
    }

    if (isBalancedMarkdownPrefix(buffer.slice(0, candidate))) {
      return candidate;
    }
  }

  if (buffer.length >= STREAM_HARD_FLUSH_CHARS) {
    const fallbackWhitespace = findLastWhitespaceBoundary(buffer);
    if (fallbackWhitespace > 0) {
      return fallbackWhitespace;
    }

    return STREAM_HARD_FLUSH_CHARS;
  }

  return 0;
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (entity, raw) => {
    if (raw.startsWith("#x") || raw.startsWith("#X")) {
      const codePoint = Number.parseInt(raw.slice(2), 16);
      if (Number.isFinite(codePoint)) {
        return String.fromCodePoint(codePoint);
      }
      return entity;
    }

    if (raw.startsWith("#")) {
      const codePoint = Number.parseInt(raw.slice(1), 10);
      if (Number.isFinite(codePoint)) {
        return String.fromCodePoint(codePoint);
      }
      return entity;
    }

    return htmlEntityMap[raw] ?? entity;
  });
}

function stripTags(html: string): string {
  const withoutAnnotations = html
    .replace(/<annotation[\s\S]*?<\/annotation>/g, " ")
    .replace(/<annotation-xml[\s\S]*?<\/annotation-xml>/g, " ");
  const withoutTags = withoutAnnotations.replace(/<[^>]*>/g, " ");
  const decoded = decodeHtmlEntities(withoutTags);
  return decoded.replace(/\s+/g, " ").trim();
}

function renderMath(expression: string, displayMode: boolean): string {
  const source = expression.trim();
  if (!source) {
    return "";
  }

  try {
    const rendered = katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "mathml"
    });
    const plain = stripTags(rendered);
    if (!plain) {
      return displayMode ? `\n${source}\n` : source;
    }
    return displayMode ? `\n${plain}\n` : plain;
  } catch {
    return displayMode ? `\n${source}\n` : source;
  }
}

function transformMathInSegment(segment: string): string {
  const withBlockDollar = segment.replace(blockMathDollarPattern, (_, expression: string) =>
    renderMath(expression, true)
  );

  const withBlockBracket = withBlockDollar.replace(
    blockMathBracketPattern,
    (_, expression: string) => renderMath(expression, true)
  );

  const withInlineDollar = withBlockBracket.replace(
    inlineMathDollarPattern,
    (_, expression: string) => renderMath(expression, false)
  );

  return withInlineDollar.replace(inlineMathParenPattern, (_, expression: string) =>
    renderMath(expression, false)
  );
}

function transformMath(markdown: string): string {
  const parts = markdown.split(fencedCodePattern);
  return parts
    .map((part) => {
      if (part.startsWith("```")) {
        return part;
      }
      return transformMathInSegment(part);
    })
    .join("");
}

export function transformMarkdownForDisplay(markdown: string): string {
  if (!markdown) {
    return "";
  }

  return transformMath(markdown);
}

export interface MarkdownStreamTransformer {
  push(chunk: string): string;
  flush(): string;
}

export function createMarkdownStreamTransformer(): MarkdownStreamTransformer {
  let pending = "";

  const drain = (force: boolean): string => {
    if (pending.length === 0) {
      return "";
    }

    let output = "";
    while (pending.length > 0) {
      const boundary = force ? pending.length : findStreamFlushBoundary(pending);
      if (boundary <= 0) {
        break;
      }

      const nextSlice = pending.slice(0, boundary);
      pending = pending.slice(boundary);
      output += transformMarkdownForDisplay(nextSlice);

      if (force) {
        break;
      }
    }

    return output;
  };

  return {
    push(chunk: string): string {
      if (!chunk) {
        return "";
      }

      pending += chunk;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    }
  };
}