"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../Chat.module.css";
import { ChevronRightIcon, FileIcon, GitBranchIcon, GlobeIcon, PackageIcon, SpannerIcon, TerminalIcon, WarningIcon } from "@/components/icons";
import type { ToolIcon } from "@/lib/agentTools";
import type { ApprovalDecision, PauseDecision, StepSecurity, ToolStep } from "@/lib/types";

/**
 * The icon of a tool step: a globe for the web tools, a file for the file
 * tools, a terminal for running code, a package for installing packages, a
 * spanner for the rest.
 */
export function ToolStepIcon({ icon, className }: { icon: ToolIcon; className?: string }) {
  if (icon === "globe") return <GlobeIcon className={className} />;
  if (icon === "code") return <TerminalIcon className={className} />;
  if (icon === "package") return <PackageIcon className={className} />;
  if (icon === "git") return <GitBranchIcon className={className} />;
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
 * Text behind a chevron, collapsed at first: what the classifier flagged, the
 * code a dialog asks about, or the summary of a checkpoint. It shows as plain
 * text in a box that scrolls, never as markdown, so no link in it can be
 * clicked and no image in it loads.
 */
export function Expandable({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement | null>(null);
  // Opened, the text comes into view with what holds it, such as a dialog's
  // choices below it, also within the trace's own scrolling area
  useEffect(() => {
    if (open) (root.current?.parentElement ?? root.current)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);
  return (
    <span ref={root} className={styles.flagged}>
      <button type="button" className={styles.flaggedToggle} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRightIcon className={styles.thinkingChevron} />
        {label}
      </button>
      {open && (
        <span className={styles.flaggedText}>
          {text}
        </span>
      )}
    </span>
  );
}

/**
 * One tool call in a reply's trace: what it did, and a screenshot's thumbnail.
 * When the security checks withheld its result, it says why, and the text they
 * flagged opens below a chevron. While the reply is paused over it
 * (`pauseId`), it is a dialog, and the choice goes to the server, which goes
 * on with the reply or ends it: about flagged content, "Remove and continue"
 * or "Stop"; about running code in a chat with such content, run it or not.
 */
export default function ToolLine({ step }: { step: ToolStep }) {
  const { security, approval } = step;
  const asking = !!step.pauseId && !!security && !security.decision;
  const approving = !!step.pauseId && !!approval && !approval.decision;
  // The choice that is on its way to the server
  const [chosen, setChosen] = useState<PauseDecision | ApprovalDecision | null>(null);

  async function choose(decision: PauseDecision | ApprovalDecision) {
    setChosen(decision);
    const res = await fetch(`/api/chat/pauses/${encodeURIComponent(step.pauseId ?? "")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    }).catch(() => null);
    // The tool line gets the outcome from the reply's stream; on a failure, the choice is open again
    if (!res?.ok) setChosen(null);
  }

  const installs = step.name === "install_packages";

  return (
    <div id={`tool-${step.id}`} className={`${styles.toolStep} ${step.state === "error" ? styles.toolStepFailed : ""}`}>
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
      {approving && (
        <div
          className={`${styles.toolNotice} ${styles.toolNoticeAsking}`}
          role="alertdialog"
          aria-label={installs ? "Install these packages?" : "Run this code?"}
        >
          <WarningIcon className={styles.warnIcon} />
          <span>
            Text in this chat tried to instruct the model. {installs ? "Install these packages?" : "Run this code?"}
          </span>
          {approval.detail && <Expandable label={installs ? "Packages" : "Code"} text={approval.detail} />}
          <span className={styles.choices}>
            <button type="button" className={styles.choiceButton} onClick={() => choose("run")} disabled={chosen !== null}>
              {installs ? "Install" : "Run"}
            </button>
            <button
              type="button"
              className={`${styles.choiceButton} ${styles.choiceSafe}`}
              onClick={() => choose("skip")}
              disabled={chosen !== null}
            >
              {installs ? "Don't install" : "Don't run"}
            </button>
          </span>
        </div>
      )}
      {security && (
        <div
          className={`${styles.toolNotice} ${asking ? styles.toolNoticeAsking : ""}`}
          role={asking ? "alertdialog" : undefined}
          aria-label={asking ? "Flagged content" : undefined}
        >
          <WarningIcon className={styles.warnIcon} />
          <span>{securityNote(security)}</span>
          {security.chunk && <Expandable label="Flagged text" text={security.chunk} />}
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
