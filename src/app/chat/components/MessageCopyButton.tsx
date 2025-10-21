"use client";

import { useState } from "react";
import styles from "../Chat.module.css";
import { copyTextToClipboard } from "../utils/clipboard";

export default function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={styles.messageCopyBtn}
      aria-label={copied ? "Copied!" : "Copy response"}
      title={copied ? "Copied!" : "Copy"}
      onClick={async () => {
        const ok = await copyTextToClipboard(text);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }
      }}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="#22c55e" aria-hidden="true">
          <path d="M9 16.2l-3.5-3.5L4 14.2 9 19l11-11-1.5-1.5z" />
        </svg>
      ) : (
        <img src="/copy.svg" alt="" aria-hidden="true" />
      )}
    </button>
  );
}