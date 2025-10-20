"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import styles from "./Table.module.css";

export default function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[rehypeHighlight]}
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
      {content}
    </ReactMarkdown>
  );
}