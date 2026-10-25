"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../Chat.module.css";
import { isNarrowViewport } from "@/lib/viewport";

// The draft lives here rather than in the page, so typing does not re-render
// the message list or the sidebar.
export default function Composer({
  isStreaming,
  onSend,
  onCancel,
}: {
  isStreaming: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState("");
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize
  useEffect(() => {
    const ta = textAreaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(200, ta.scrollHeight) + "px";
  }, [input]);

  // The on-screen keyboard shortens the viewport (see the chat layout). While the
  // textarea has focus, scroll down by the same amount, so the messages just above
  // the composer stay in view instead of sliding under it. When the keyboard
  // closes, the browser itself keeps the page end in place.
  useEffect(() => {
    let height = window.innerHeight;
    function onResize() {
      const shrunk = height - window.innerHeight;
      height = window.innerHeight;
      if (shrunk > 0 && document.activeElement === textAreaRef.current) window.scrollBy(0, shrunk);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The textarea is disabled while streaming and loses focus. Give it back when
  // the reply completes (not on mobile, where focus opens the keyboard).
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    const ta = textAreaRef.current;
    if (wasStreaming.current && !isStreaming && ta && !isNarrowViewport()) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

  function submit() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    // Close the on-screen keyboard now, so the viewport does not resize while the reply streams in
    textAreaRef.current?.blur();
    onSend(text);
  }

  return (
    <form
      className={styles.composer}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textAreaRef}
        value={input}
        disabled={isStreaming}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter adds a newline. Ignore Enter while an IME is composing.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
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
