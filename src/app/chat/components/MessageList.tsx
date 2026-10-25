"use client";

import { memo, useEffect, useRef } from "react";
import styles from "../Chat.module.css";
import MarkdownMessage from "./MarkdownMessage";
import CopyButton from "./CopyButton";
import type { DisplayMessage } from "@/lib/types";

const STREAM_ERROR_NOTE = "\n\n*(Stream error)*";

function MessageList({
  messages,
  isStreaming,
}: {
  messages: DisplayMessage[];
  isStreaming: boolean;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <section className={styles.messages} aria-live="polite" aria-label="Chat messages">
      {messages.map((msg, idx) => {
        const isUser = msg.role === "user";
        // Hide the copy button on the reply that is still streaming
        const showCopy = !isUser && (!isStreaming || idx !== messages.length - 1);
        return (
          <div key={idx} className={`${styles.messageRow} ${isUser ? styles.user : styles.bot}`}>
            <div className={styles.bubble}>
              <MarkdownMessage content={msg.error ? msg.content + STREAM_ERROR_NOTE : msg.content} />
              {showCopy && (
                <CopyButton className={styles.messageCopyBtn} label="Copy response" getText={() => msg.content} />
              )}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </section>
  );
}

export default memo(MessageList);
