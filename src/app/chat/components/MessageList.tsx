"use client";

import { memo } from "react";
import styles from "../Chat.module.css";
import MarkdownMessage from "./MarkdownMessage";
import FileCards from "./FileCards";
import Reply from "./Reply";
import CheckpointMarker, { CompactionFailed } from "./CheckpointMarker";
import { useAutoScroll } from "../hooks/useAutoScroll";
import type { DisplayMessage, ReplyStatus } from "@/lib/types";

function MessageList({
  messages,
  isStreaming,
  replyStatus,
  onUndoCompact,
}: {
  messages: DisplayMessage[];
  isStreaming: boolean;
  replyStatus: ReplyStatus | null;
  onUndoCompact: () => void; // takes the user's last compaction back
}) {
  const endRef = useAutoScroll(messages, isStreaming);

  return (
    <section className={styles.messages} aria-live="polite" aria-label="Chat messages">
      {messages.map((msg, idx) => {
        // Not a message: where the user had the conversation summarised for the model, or why that failed
        if (msg.role === "system") {
          return (
            <div key={idx} className={`${styles.messageRow} ${styles.bot}`}>
              <div className={styles.thinking}>
                {msg.checkpoint ? (
                  <CheckpointMarker checkpoint={msg.checkpoint} onUndo={isStreaming ? undefined : onUndoCompact} />
                ) : (
                  <CompactionFailed message={msg.error ?? ""} />
                )}
              </div>
            </div>
          );
        }
        if (msg.role === "assistant") {
          // The reply that is still streaming
          const live = isStreaming && idx === messages.length - 1;
          return <Reply key={idx} msg={msg} live={live} status={live ? replyStatus : null} />;
        }
        return (
          <div key={idx} className={`${styles.messageRow} ${styles.user} ${msg.files?.length ? styles.withFiles : ""}`}>
            {!!msg.files?.length && <FileCards files={msg.files} />}
            {/* A message of only files has no bubble */}
            {(!!msg.content || !msg.files?.length) && (
              <div className={styles.bubble}>
                <MarkdownMessage content={msg.content} />
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
