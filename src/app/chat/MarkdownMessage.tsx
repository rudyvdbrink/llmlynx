"use client";

import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import styles from "./Table.module.css";

/**
 * Normalize TeX-style delimiters \( ... \) and \[ ... \] in the raw markdown
 * to $ ... $ and $$ ... $$ so remark-math can parse them.
 * We temporarily stash fenced and inline code so we don't touch them.
 */
function normalizeTeXDelimiters(input: string): string {
  const BLOCK_TOKEN_START = "\uE000";
  const INLINE_TOKEN_START = "\uE002";
  const TOKEN_END = "\uE001";
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

  // Replace \[ ... \] -> $$ ... $$  and  \( ... \) -> $ ... $
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

export default function MarkdownMessage({ content }: { content: string }) {
  const normalized = useMemo(() => normalizeTeXDelimiters(content), [content]);

  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkMath,   // parse $...$ and $$...$$
        remarkGfm,
        remarkBreaks,
      ]}
      rehypePlugins={[
        [rehypeKatex, { throwOnError: false }],
        rehypeHighlight,
      ]}
      components={{
        a: ({ node, ...props }) => (
          <a {...props} target="_blank" rel="nofollow noopener noreferrer" />
        ),
        table: ({ node, ...props }) => (
          <div className={styles.mdTableWrapper}>
            <table {...props} />
          </div>
        ),
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
}