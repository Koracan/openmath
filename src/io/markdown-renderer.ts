import katex from "katex";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

const blockMathDollarPattern = /\$\$([\s\S]+?)\$\$/g;
const blockMathBracketPattern = /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g;
const inlineMathDollarPattern = /(?<!\\)\$([^\n$]+?)\$/g;
const inlineMathParenPattern = /(?<!\\)\\\((.+?)(?<!\\)\\\)/g;
const fencedCodePattern = /(```[\s\S]*?```)/g;

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

function renderStrongText(text: string): string {
  if (!process.stdout.isTTY) {
    return `**${text}**`;
  }

  return `\u001b[1;33m${text}\u001b[0m`;
}

marked.use(
  markedTerminal({
    reflowText: true,
    strong: renderStrongText
  })
);

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

export function renderMarkdownForTerminal(markdown: string): string {
  const transformed = transformMath(markdown);
  const rendered = marked.parse(transformed);
  return typeof rendered === "string" ? rendered : transformed;
}