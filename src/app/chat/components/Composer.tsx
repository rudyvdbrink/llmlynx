"use client";

import { useEffect, useRef } from "react";
import styles from "../Chat.module.css";

export default function Composer({
  input,
  setInput,
  isStreaming,
  onSubmit,
  onKeyDown,
  onCancel,
}: {
  input: string;
  setInput: (v: string) => void;
  isStreaming: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCancel: () => void;
}) {
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize
  useEffect(() => {
    const ta = textAreaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(200, ta.scrollHeight) + "px";
  }, [input]);

  return (
    <form className={styles.composer} onSubmit={onSubmit}>
      <textarea
        ref={textAreaRef}
        value={input}
        disabled={isStreaming}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={isStreaming ? "Model is responding..." : "Ask the llynx..."}
        aria-label="Message"
        rows={1}
      />
      {isStreaming ? (
        <button
          type="button"
          aria-label="Stop response"
          className={`${styles.stopButton} ${styles.iconButton}`}
          onClick={onCancel}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="7" y="7" width="10" height="10" rx="1" />
          </svg>
        </button>
      ) : (
        <button
          type="submit"
          aria-label="Send"
          disabled={!input.trim()}
          className={styles.iconButton}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 12L20 4L12 20L11 13L4 12Z" transform="translate(-0.5 0)" />
          </svg>
        </button>
      )}
    </form>
  );
}