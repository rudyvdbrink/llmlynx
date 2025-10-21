"use client";

import React, { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import tableStyles from "../Table.module.css";
import chatStyles from "../Chat.module.css";

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

/**
 * Try to read the language from:
 * - a "data-lang" or "data-language" on the child element
 * - a "language-xxx" class on the child element
 * - a "language-xxx" class on the pre element
 */
function getLangFromChildren(children: React.ReactNode, preClassName?: string): string {
  let lang = "";

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const props: any = child.props || {};

    const dataLang: string | undefined = props["data-lang"] || props["data-language"];
    if (typeof dataLang === "string" && dataLang) {
      lang = dataLang.toLowerCase();
      return;
    }

    const cls: string = props.className || "";
    const m = String(cls).match(/language-([a-z0-9+\-]+)/i);
    if (m?.[1]) {
      lang = m[1].toLowerCase();
      return;
    }
  });

  if (!lang && preClassName) {
    const m2 = String(preClassName).match(/language-([a-z0-9+\-]+)/i);
    if (m2?.[1]) lang = m2[1].toLowerCase();
  }

  return lang || "text";
}

export default function MarkdownMessage({ content }: { content: string }) {
  const normalized = useMemo(() => normalizeTeXDelimiters(content), [content]);

  // Custom <pre> element to add a top bar with language and copy action
  const PreWithCopy: React.FC<React.HTMLAttributes<HTMLPreElement>> = (props) => {
    const preRef = useRef<HTMLPreElement | null>(null);
    const [copied, setCopied] = useState(false);

    // Compute the label directly from the React element tree; no state/effect needed
    const langLabel = useMemo(
      () => getLangFromChildren(props.children, props.className as string | undefined),
      [props.children, props.className]
    );

    return (
      <div className={chatStyles.codeBlockWrapper}>
        <div className={chatStyles.codeHeader}>
          <div className={chatStyles.codeHeaderLeft}>
            <span className={chatStyles.codeLanguage}>{langLabel}</span>
          </div>
          <div className={chatStyles.codeHeaderRight}>
            <span className={chatStyles.copyLabel}>copy code</span>
            <button
              type="button"
              className={chatStyles.copyCodeBtn}
              aria-label="Copy code"
              title={copied ? "Copied!" : "Copy"}
              onClick={async (e) => {
                const codeEl = preRef.current?.querySelector("code");
                const text = codeEl?.textContent ?? "";
                const ok = await copyTextToClipboard(text);
                if (ok) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }
              }}
            >
              {copied ? (
                // Green check mark
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="#22c55e"
                  aria-hidden="true"
                >
                  <path d="M9 16.2l-3.5-3.5L4 14.2 9 19l11-11-1.5-1.5z" />
                </svg>
              ) : (
                <img src="/copy.svg" alt="" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
        <pre ref={preRef} {...props} />
      </div>
    );
  };

  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm, remarkBreaks]}
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
        // Add the header to block code without breaking HTML semantics
        pre: PreWithCopy,
        // Inline code remains inline; block code is handled by the pre wrapper
        code: ({ inline, className, children, ...props }: any) => {
          if (inline) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
          // Attach data-lang so the pre wrapper can reliably read the language
          const lang =
            (className && (className.match(/language-([a-z0-9+\-]+)/i)?.[1] || "")) || "";
          const dataProps: any = {};
          if (lang) dataProps["data-lang"] = lang.toLowerCase();

          return (
            <code className={className} {...dataProps} {...props}>
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