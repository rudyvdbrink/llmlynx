"use client";

import { useEffect, useRef } from "react";
import styles from "../Chat.module.css";
import MarkdownMessage from "./MarkdownMessage";
import MessageCopyButton from "./MessageCopyButton";
import { UiMessage } from "../types/chat";

export default function MessageList({
  uiMessages,
  isStreaming,
}: {
  uiMessages: UiMessage[];
  isStreaming: boolean;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [uiMessages]);

  return (
    <section className={styles.messages} aria-live="polite" aria-label="Chat messages">
      {uiMessages.map((msg, idx) => {
        const showMessageCopy = msg.sender === "bot" && (!isStreaming || idx !== uiMessages.length - 1);
        return (
          <div
            key={idx}
            className={`${styles.messageRow} ${msg.sender === "user" ? styles.user : styles.bot}`}
          >
            <div className={styles.bubble}>
              <MarkdownMessage content={msg.text} />
              {showMessageCopy && <MessageCopyButton text={msg.text} />}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </section>
  );
}