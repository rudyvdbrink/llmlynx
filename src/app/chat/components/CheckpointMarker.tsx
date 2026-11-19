"use client";

import styles from "../Chat.module.css";
import { FoldIcon, WarningIcon } from "@/components/icons";
import type { Checkpoint } from "@/lib/types";
import { isPendingCheckpoint } from "../hooks/useChat";
import { Expandable } from "./ToolLine";

/**
 * Marks where older steps of the conversation were summarised for the model
 * (see server/chat/checkpoint.ts): between the messages when the user asked
 * for it with /compact, and in a reply's trace (`inTrace`) when it was made
 * while that reply ran, as the model's context window was full. The summary
 * opens below a chevron. A compaction of the user can be taken back
 * (`onUndo`) while nothing was said since.
 */
export default function CheckpointMarker({
  checkpoint,
  inTrace = false,
  onUndo,
}: {
  checkpoint: Checkpoint;
  inTrace?: boolean;
  onUndo?: () => void;
}) {
  const pending = isPendingCheckpoint(checkpoint);
  const label = pending
    ? "Compacting the conversation…"
    : inTrace
      ? "Earlier steps were summarised to save room"
      : "Conversation compacted";
  return (
    <div className={styles.toolStep} role={pending ? "status" : undefined}>
      {pending ? <span className={styles.spinner} aria-hidden="true" /> : <FoldIcon className={styles.toolIcon} />}
      <span className={styles.toolLabel}>{label}</span>
      {!pending && (
        <div className={styles.checkpointMore}>
          <Expandable label="Summary" text={checkpoint.summary} />
          {checkpoint.canUndo && onUndo && (
            <button type="button" className={styles.choiceButton} onClick={onUndo}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** In a checkpoint's place when a compaction the user asked for could not be made: why. It is not stored. */
export function CompactionFailed({ message }: { message: string }) {
  return (
    <div className={`${styles.toolStep} ${styles.checkpointFailed}`} role="alert">
      <WarningIcon className={styles.warnIcon} />
      <span>{message}</span>
    </div>
  );
}
