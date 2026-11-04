"use client";

import { memo } from "react";
import styles from "../Chat.module.css";
import MarkdownMessage from "./MarkdownMessage";
import CopyButton from "./CopyButton";
import Thinking from "./Thinking";
import { useAutoScroll } from "../hooks/useAutoScroll";
import type { DisplayMessage, ReplyStatus } from "@/lib/types";

const errorNote = (error: string) => `\n\n*(Error: ${error})*`;

function MessageList({
  messages,
  isStreaming,
  replyStatus,
  answering,
}: {
  messages: DisplayMessage[];
  isStreaming: boolean;
  replyStatus: ReplyStatus | null;
  answering: boolean; // the streaming reply's text is coming in (not thinking or using a tool)
}) {
  const endRef = useAutoScroll(messages, isStreaming);

  return (
    <section className={styles.messages} aria-live="polite" aria-label="Chat messages">
      {messages.map((msg, idx) => {
        const isUser = msg.role === "user";
        // The reply that is still streaming
        const isReply = !isUser && isStreaming && idx === messages.length - 1;
        // Until its text starts, and while it uses a tool, the reply shows what the model is doing
        const waiting = isReply && !answering && !msg.error;
        // Hide the copy button on the reply that is still streaming
        const showCopy = !isUser && !isReply;
        return (
          <div key={idx} className={`${styles.messageRow} ${isUser ? styles.user : styles.bot}`}>
            {(waiting || !!msg.trace?.length) && <Thinking trace={msg.trace} status={waiting ? replyStatus : "done"} />}
            {(!waiting || msg.content) && (
              <div className={styles.bubble}>
                <MarkdownMessage content={msg.error ? msg.content + errorNote(msg.error) : msg.content} />
                {showCopy && (
                  <CopyButton className={styles.messageCopyBtn} label="Copy response" getText={() => msg.content} />
                )}
              </div>
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </section>
  );
}

export default memo(MessageList);
