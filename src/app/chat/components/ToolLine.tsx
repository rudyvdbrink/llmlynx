"use client";

import { useState } from "react";
import styles from "../Chat.module.css";
import { FileIcon, GlobeIcon, SpannerIcon, WarningIcon } from "@/components/icons";
import type { ToolIcon } from "@/lib/agentTools";
import type { PauseDecision, StepSecurity, ToolStep } from "@/lib/types";

/** The icon of a tool step: a globe for the web tools, a file for the file tools, a spanner for the rest. */
export function ToolStepIcon({ icon, className }: { icon: ToolIcon; className?: string }) {
  if (icon === "globe") return <GlobeIcon className={className} />;
  return icon === "file" ? <FileIcon className={className} /> : <SpannerIcon className={className} />;
}

/** What the security checks did with a result, in words. `source` is a page's host, or a file name. */
function securityNote({ flag, source = "this source", decision }: StepSecurity): string {
  if (flag === "virus") return `Content from ${source} was flagged as malware and discarded.`;
  if (flag === "unchecked") return `Content from ${source} could not be checked, so the model did not get it.`;
  const what = `Text from ${source} looks like instructions aimed at the model. The model did not get it.`;
  if (decision === "remove") return `${what} You chose to go on without it.`;
  return decision === "stop" ? `${what} The reply was stopped.` : what;
}

/**
 * One tool call in a reply's trace: what it did, and a screenshot's thumbnail.
 * When the security checks withheld its result, it says why. While the reply
 * is paused over it (`pauseId`), it is the pause dialog: the user chooses
 * "Remove and continue" or "Stop", and the choice goes to the server, which
 * goes on with the reply or ends it.
 */
export default function ToolLine({ step }: { step: ToolStep }) {
  const { security } = step;
  const asking = !!step.pauseId && !security?.decision;
  // The choice that is on its way to the server
  const [chosen, setChosen] = useState<PauseDecision | null>(null);

  async function choose(decision: PauseDecision) {
    setChosen(decision);
    const res = await fetch(`/api/chat/pauses/${encodeURIComponent(step.pauseId ?? "")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    }).catch(() => null);
    // The tool line gets the outcome from the reply's stream; on a failure, the choice is open again
    if (!res?.ok) setChosen(null);
  }

  return (
    <div className={`${styles.toolStep} ${step.state === "error" ? styles.toolStepFailed : ""}`}>
      <ToolStepIcon icon={step.icon} className={styles.toolIcon} />
      <span className={styles.toolLabel} title={step.label}>
        {step.label}
      </span>
      {step.attachmentId && (
        <a
          className={styles.toolShot}
          href={`/api/attachments/${step.attachmentId}`}
          target="_blank"
          rel="noopener"
          aria-label={`Open the screenshot: ${step.label}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset */}
          <img src={`/api/attachments/${step.attachmentId}`} alt="" loading="lazy" />
        </a>
      )}
      {security && (
        <div
          className={`${styles.toolNotice} ${asking ? styles.toolNoticeAsking : ""}`}
          role={asking ? "alertdialog" : undefined}
          aria-label={asking ? "Flagged content" : undefined}
        >
          <WarningIcon className={styles.warnIcon} />
          <span>{securityNote(security)}</span>
          {asking && (
            <span className={styles.choices}>
              <button
                type="button"
                className={`${styles.choiceButton} ${styles.choiceSafe}`}
                onClick={() => choose("remove")}
                disabled={chosen !== null}
              >
                Remove and continue
              </button>
              <button type="button" className={styles.choiceButton} onClick={() => choose("stop")} disabled={chosen !== null}>
                Stop
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
