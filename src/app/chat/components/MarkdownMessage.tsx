"use client";

import React, { memo, useMemo, useRef } from "react";
import ReactMarkdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import tableStyles from "../Table.module.css";
import chatStyles from "../Chat.module.css";
import CopyButton from "./CopyButton";

/**
 * Normalize TeX-style delimiters \( ... \) and \[ ... \] in the raw markdown
 * to $ ... $ and $$ ... $$ so remark-math can parse them.
 * We temporarily stash fenced and inline code so we don't touch them.
 */
function normalizeTeXDelimiters(input: string): string {
  const BLOCK_TOKEN_START = "";
  const INLINE_TOKEN_START = "";
  const TOKEN_END = "";
  const stash: string[] = [];

  // Stash fenced code blocks ```...```
  let text = input.replace(/```[\s\S]*?```/g, (m) => {
    const id = stash.push(m) - 1;
    return `${BLOCK_TOKEN_START}${id}${TOKEN_END}`;
  });

  // Stash inline code `...`
  text = text.replace(/`[^`]*`/g, (m) => {
    const id = stash.push(m) - 1;
    return `${INLINE_TOKEN_START}${id}${TOKEN_END}`;
  });

  // remark-math reads $$ ... $$ within a line as inline math. A \[ ... \] or
  // $$ ... $$ that fills its own line(s) becomes a $$ block, so it renders as
  // display math (which scrolls sideways when it is too wide).
  const toBlock = (_: string, indent: string, inner: string) => `${indent}$$\n${indent}${inner.trim()}\n${indent}$$`;
  text = text.replace(/^([ \t]*)\\\[([\s\S]*?)\\\][ \t]*$/gm, toBlock);
  text = text.replace(/^([ \t]*)\$\$((?:(?!\$\$)[^\n])+)\$\$[ \t]*$/gm, toBlock);

  // Replace the remaining \[ ... \] -> $$ ... $$  and  \( ... \) -> $ ... $
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_: string, inner: string) => `$$${inner}$$`);
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_: string, inner: string) => `$${inner}$`);

  // Restore stashed segments
  text = text.replace(
    new RegExp(`${BLOCK_TOKEN_START}(\\d+)${TOKEN_END}`, "g"),
    (_: string, n: string) => stash[Number(n)]
  );
  text = text.replace(
    new RegExp(`${INLINE_TOKEN_START}(\\d+)${TOKEN_END}`, "g"),
    (_: string, n: string) => stash[Number(n)]
  );

  return text;
}

const LANGUAGE_CLASS = /language-([a-z0-9+\-]+)/i;

/** Reads the language from a "language-xxx" class on the <code> child, or else on the <pre>. */
function getCodeLanguage(children: React.ReactNode, preClassName?: string): string {
  let lang = "";
  React.Children.forEach(children, (child) => {
    if (lang || !React.isValidElement<{ className?: string }>(child)) return;
    lang = child.props.className?.match(LANGUAGE_CLASS)?.[1] ?? "";
  });
  lang ||= preClassName?.match(LANGUAGE_CLASS)?.[1] ?? "";
  return lang.toLowerCase() || "text";
}

// Block code gets a top bar with the language and a copy action.
function PreWithCopy({ node, ...props }: React.ComponentProps<"pre"> & ExtraProps) {
  const preRef = useRef<HTMLPreElement | null>(null);

  return (
    <div className={chatStyles.codeBlockWrapper}>
      <div className={chatStyles.codeHeader}>
        <div className={chatStyles.codeHeaderLeft}>
          <span className={chatStyles.codeLanguage}>{getCodeLanguage(props.children, props.className)}</span>
        </div>
        <div className={chatStyles.codeHeaderRight}>
          <span className={chatStyles.copyLabel}>copy code</span>
          <CopyButton
            className={chatStyles.copyCodeBtn}
            label="Copy code"
            getText={() => preRef.current?.querySelector("code")?.textContent ?? ""}
          />
        </div>
      </div>
      <pre ref={preRef} {...props} />
    </div>
  );
}

// Defined once at module level: inline definitions would give React new
// component types on every render and remount every code block per token.
const COMPONENTS: Components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="nofollow noopener noreferrer" />,
  table: ({ node, ...props }) => (
    <div className={tableStyles.mdTableWrapper}>
      <table {...props} />
    </div>
  ),
  pre: PreWithCopy,
};

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkMath, remarkGfm, remarkBreaks];
const REHYPE_PLUGINS: Options["rehypePlugins"] = [[rehypeKatex, { throwOnError: false }], rehypeHighlight];

function MarkdownMessage({ content }: { content: string }) {
  const normalized = useMemo(() => normalizeTeXDelimiters(content), [content]);

  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
      {normalized}
    </ReactMarkdown>
  );
}

// Memoized so that earlier messages are not re-parsed while a reply streams in.
export default memo(MarkdownMessage);
