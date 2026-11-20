"use client";

import { memo, useMemo } from "react";
import styles from "../Chat.module.css";
import MarkdownMessage from "./MarkdownMessage";
import CopyButton from "./CopyButton";
import Thinking from "./Thinking";
import FileCards from "./FileCards";
import type { DisplayMessage, ReplyStatus, TraceItem } from "@/lib/types";

const errorNote = (error: string) => `*(Error: ${error})*`;

// A part of a reply: text the model wrote to the user, or what it did between two such texts
type Part = { kind: "text"; text: string } | { kind: "thinking"; items: TraceItem[] };

/** The reply's trace in parts, in order, with why it failed as text at its end. */
function partsOf(trace: TraceItem[], error?: string): Part[] {
  const parts: Part[] = [];
  for (const item of trace) {
    const last = parts[parts.length - 1];
    if (item.kind === "text") parts.push({ kind: "text", text: item.text });
    else if (last?.kind === "thinking") last.items.push(item);
    else parts.push({ kind: "thinking", items: [item] });
  }
  if (error) {
    const last = parts[parts.length - 1];
    if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: `${last.text}\n\n${errorNote(error)}` };
    else parts.push({ kind: "text", text: errorNote(error) });
  }
  return parts;
}

/**
 * The colour of a thinking part's dot: amber when a tool call in it failed or
 * the security checks withheld its result, so the user can find what went
 * wrong; blue when it used tools; grey when it only reasoned.
 */
function dotOf(items: TraceItem[]): string {
  const steps = items.flatMap((item) => (item.kind === "tool" ? [item.step] : []));
  if (steps.some((step) => step.state === "error" || !!step.security)) return styles.dotIssue;
  return steps.length ? styles.dotTools : styles.dotThinking;
}

/**
 * A reply, as a timeline of its parts: each text the model wrote to the user,
 * and what it did between them (its reasoning and tool calls), which folds
 * away behind a "Show thinking" toggle once the next text starts. A dot marks
 * each part, and a line joins them; a reply that is only text has neither.
 * While the reply comes in (`live`), its
 * last part shows what the model is doing now, with the status icon in the
 * place of its dot; when that is text, its dot pulses. Below the parts: the
 * files the agent made, and the copy button once the reply is over.
 */
function Reply({ msg, live, status }: { msg: DisplayMessage; live: boolean; status: ReplyStatus | null }) {
  const parts = useMemo(() => partsOf(msg.trace ?? [], msg.error), [msg.trace, msg.error]);
  // Until its text starts, and between its texts, the reply shows what the model is doing
  const waiting = live && parts[parts.length - 1]?.kind !== "text";
  const shown: Part[] = waiting && !parts.length ? [{ kind: "thinking", items: [] }] : parts;

  return (
    <div className={`${styles.messageRow} ${styles.bot}`}>
      <div className={styles.timeline}>
        {shown.map((part, i) => {
          const last = i === shown.length - 1;
          if (part.kind === "text") {
            return (
              <div key={`text${i}`} className={`${styles.part} ${styles.textPart}`}>
                {shown.length > 1 && <span className={`${styles.dot} ${styles.dotText} ${live && last ? styles.dotLive : ""}`} />}
                <div className={styles.bubble}>
                  <MarkdownMessage content={part.text} />
                </div>
              </div>
            );
          }
          const current = waiting && last;
          return (
            <div key={`thinking${i}`} className={`${styles.part} ${current ? styles.livePart : ""}`}>
              {!current && <span className={`${styles.dot} ${dotOf(part.items)}`} />}
              <Thinking trace={part.items} status={current ? status : "done"} />
            </div>
          );
        })}
      </div>
      {(!waiting || !!msg.content) && (
        <div className={`${styles.bubble} ${styles.replyEnd}`}>
          {!!msg.files?.length && <FileCards files={msg.files} />}
          {!live && <CopyButton className={styles.messageCopyBtn} label="Copy response" getText={() => msg.content} />}
        </div>
      )}
    </div>
  );
}

export default memo(Reply);
