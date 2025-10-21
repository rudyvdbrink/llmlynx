"use client";

import React, { useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import tableStyles from "./Table.module.css";
import chatStyles from "./Chat.module.css";

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

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

export default function MarkdownMessage({ content }: { content: string }) {
  const normalized = useMemo(() => normalizeTeXDelimiters(content), [content]);

  // Custom pre element to wrap code blocks with a copy button without breaking HTML semantics
  const PreWithCopy: React.FC<React.HTMLAttributes<HTMLPreElement>> = (props) => {
    const preRef = useRef<HTMLPreElement | null>(null);

    return (
      <div className={chatStyles.codeBlockWrapper}>
        <button
          type="button"
          className={chatStyles.copyCodeBtn}
          aria-label="Copy code"
          title="Copy"
          onClick={async (e) => {
            const btn = e.currentTarget as HTMLButtonElement; // capture before awaiting
            const text = preRef.current?.textContent ?? "";
            const ok = await copyTextToClipboard(text);
            const prev = btn.title;
            btn.title = ok ? "Copied!" : "Copy failed";
            setTimeout(() => {
              btn.title = prev;
            }, 1200);
          }}
        >
          <img src="/copy.svg" alt="" aria-hidden="true" />
        </button>
        <pre ref={preRef} {...props} />
      </div>
    );
  };

  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkMath, // parse $...$ and $$...$$
        remarkGfm,
        remarkBreaks,
      ]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeHighlight]}
      components={{
        a: ({ node, ...props }) => (
          <a {...props} target="_blank" rel="nofollow noopener noreferrer" />
        ),
        table: ({ node, ...props }) => (
          <div className={tableStyles.mdTableWrapper}>
            <table {...props} />
          </div>
        ),
        // Override pre (block code) to add the copy button; keeps valid HTML structure
        pre: PreWithCopy,
        // Keep code element default behavior; do not wrap block code here to avoid <div> inside <p> issues
        code: ({ inline, className, children, ...props }: any) => {
          if (inline) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
          // For block code, let <pre> wrapper handle it; return code as-is
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
}