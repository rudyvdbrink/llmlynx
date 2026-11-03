"use client";

import { memo, useMemo } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import tableStyles from "../Table.module.css";

// Reasoning is rendered as markdown, but it is written less carefully than a
// reply: "11*23" means multiplication, "~5" means about five, "$5" a price.
// prepareMarkdown() sets code and math aside, escapes what is not meant as
// formatting, and gives the math to remark-math in a form it cannot misread.

// Math as models write it: $$…$$ and \[…\] are display math, \(…\) and $…$
// inline. A single $ opens only when not followed by a space, and closes only
// when not preceded by a space or followed by a digit, so "$5 and $10" is text.
const MATH =
  /(?<!\\)\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$])\$(?=[^\s$])((?:\\\$|[^$\n])*?[^\s\\$])\$(?![\d$])/g;

// Stars between operands, as in 11*23, (a+b)*(c+d) or x**2, multiply; they do not emphasize
const OPERATOR_STARS = /(?<=[\p{L}\p{N})\]}])\*+(?=[\p{L}\p{N}(\[{])/gu;

// Placeholders for text set aside, in Unicode's private use area
const STASHED = /\uE000(\d+)\uE001/g;

function prepareMarkdown(text: string): string {
  const stash: string[] = [];
  const setAside = (s: string) => `\uE000${stash.push(s) - 1}\uE001`;

  // Code stays as written: fenced blocks (also one still being written), then inline code
  let md = text.replace(/```[\s\S]*?(?:```|$)/g, setAside).replace(/`[^`\n]+`/g, setAside);

  // Inline math becomes $$…$$ within its line, which remark-math reads as inline math.
  // Display math becomes a $$ block on lines of its own, indented like its line
  // (so it stays inside a list item).
  type Group = string | undefined;
  md = md.replace(MATH, (match: string, dollars: Group, brackets: Group, parens: Group, dollar: Group, offset: number, whole: string) => {
    const inline = parens ?? dollar;
    if (inline !== undefined) return inline.trim() ? setAside(`$$${inline}$$`) : match;
    const tex = (dollars ?? brackets ?? "").trim();
    if (!tex) return match;
    const lineStart = whole.lastIndexOf("\n", offset - 1) + 1;
    const before = whole.slice(lineStart, offset);
    const indent = /^[ \t]*/.exec(before)![0];
    const after = whole.slice(offset + match.length).split("\n", 1)[0];
    const block = ["$$", ...tex.split("\n").map((line) => line.trim()), "$$"].join(`\n${indent}`);
    return setAside(before.trim() || after.trim() ? `\n${indent}${block}\n${indent}` : block);
  });

  // The rest is text: a dollar left there is not math, and stars between operands multiply
  md = md.replace(/(?<!\\)\$/g, "\\$").replace(OPERATOR_STARS, (stars) => stars.replace(/\*/g, "\\*"));

  // Put back what was set aside (math can contain set-aside code)
  for (let i = 0; i < 2 && md.includes("\uE000"); i++) md = md.replace(STASHED, (_, n: string) => stash[Number(n)]);
  return md;
}

/**
 * Splits markdown into blocks that render the same on their own: at a blank
 * line followed by an unindented line, outside fenced code and $$ math blocks.
 * Indented lines continue the block before (such as a list item's).
 */
function splitBlocks(md: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence = ""; // the fence of the code or math block the line is in
  let blank = false;
  for (const line of md.split("\n")) {
    if (!fence && blank && lines.length && /^\S/.test(line)) {
      blocks.push(lines.join("\n"));
      lines = [];
    }
    lines.push(line);
    const trimmed = line.trim();
    if (!fence) fence = /^(`{3,}|~{3,})/.exec(trimmed)?.[1] ?? (trimmed === "$$" ? "$$" : "");
    else if (trimmed.startsWith(fence) && /^(`+|~+|\$\$)$/.test(trimmed)) fence = "";
    blank = !fence && !trimmed;
  }
  if (lines.length) blocks.push(lines.join("\n"));
  return blocks;
}

const COMPONENTS: Components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="nofollow noopener noreferrer" />,
  table: ({ node, ...props }) => (
    <div className={tableStyles.mdTableWrapper}>
      <table {...props} />
    </div>
  ),
};

// Only $$…$$ is math: prepareMarkdown() decides what a single $ means. "~5" is not struck through.
const REMARK_PLUGINS: Options["remarkPlugins"] = [
  [remarkMath, { singleDollarTextMath: false }],
  [remarkGfm, { singleTilde: false }],
  remarkBreaks,
];
// Math that is not valid TeX shows as its source, in the text's color
const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, errorColor: "inherit", strict: "ignore" }],
];

// Memoized so that, while reasoning streams in, only the block being written renders again
const Block = memo(function Block({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
      {markdown}
    </ReactMarkdown>
  );
});

/** A model's reasoning, rendered as markdown with its math typeset. */
function ReasoningText({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(prepareMarkdown(text.trim())), [text]);
  return blocks.map((markdown, i) => <Block key={i} markdown={markdown} />);
}

export default memo(ReasoningText);
