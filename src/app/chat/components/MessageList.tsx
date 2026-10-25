"use client";

import { memo } from "react";
import styles from "../Chat.module.css";
import MarkdownMessage from "./MarkdownMessage";
import CopyButton from "./CopyButton";
import { useAutoScroll } from "../hooks/useAutoScroll";
import type { DisplayMessage } from "@/lib/types";

const STREAM_ERROR_NOTE = "\n\n*(Stream error)*";

function MessageList({
  messages,
  isStreaming,
}: {
  messages: DisplayMessage[];
  isStreaming: boolean;
}) {
  const endRef = useAutoScroll(messages, isStreaming);

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
