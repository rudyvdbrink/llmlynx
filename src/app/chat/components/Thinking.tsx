"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "../Chat.module.css";
import { ChevronRightIcon, WarningIcon } from "@/components/icons";
import ReasoningText from "./ReasoningText";
import ToolLine, { ToolStepIcon } from "./ToolLine";
import type { ReplyStatus, ToolStep, TraceItem } from "@/lib/types";

const LABELS: Record<ReplyStatus, string> = { reading: "Reading files…", loading: "Loading model…", thinking: "Thinking…" };

// How long the scrollbar stays visible after the user stops scrolling
const SCROLLBAR_MS = 1000;

// The reply waits for the user's choice about this step: its result, or whether its code may run (see ToolLine.tsx)
const isAsking = (item: TraceItem) =>
  item.kind === "tool" &&
  !!item.step.pauseId &&
  ((!!item.step.security && !item.step.security.decision) || (!!item.step.approval && !item.step.approval.decision));

// A running step shows in the status line, unless it asks the user something: then it is in the trace
const isRunning = (item: TraceItem): item is { kind: "tool"; step: ToolStep } =>
  item.kind === "tool" && item.step.state === "running" && !isAsking(item);

/** Asks the reply whose trace holds the tool call `id` to show it (the sandbox panel's link to a run). */
export function showToolCall(id: string) {
  window.dispatchEvent(new CustomEvent(SHOW_TOOL_EVENT, { detail: id }));
}
const SHOW_TOOL_EVENT = "llmlynx:show-tool";

/**
 * Shows what the model does before its reply starts, with one status line
 * that says what it is doing now: a spinner with "Loading model…" or
 * "Thinking…" (only the spinner while `status` is null), or, while it uses a
 * tool, the tool's icon pulsing next to what the tool does. While the reply
 * is paused over flagged content, it says that it waits for the user's
 * choice, which the tool line below offers.
 *
 * Below it, the trace streams in, in a short area that keeps its end in view:
 * the reasoning, and each tool call once it has finished, in the order they
 * happened. Once the reply starts (`status` "done"), the trace folds away
 * behind a "Show thinking" toggle.
 *
 * Reasoning is rendered as markdown, prepared so that what models do not mean
 * as formatting (such as "2*3") stays as written; see ReasoningText.tsx.
 */
export default function Thinking({ trace = [], status }: { trace?: TraceItem[]; status: ReplyStatus | "done" | null }) {
  const done = status === "done";
  const [open, setOpen] = useState(false);
  const expanded = !done || open;
  // The tool that is running shows in the status line, and joins the trace when it is done
  const running = done ? undefined : trace.find(isRunning)?.step;
  const asking = !done && trace.some(isAsking);
  const items = done ? trace : trace.filter((item) => !isRunning(item));

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Follows the end of the reasoning until the user scrolls up
  const following = useRef(true);
  // Where following last scrolled to, so that scroll is not taken for the user's
  const followedTop = useRef(-1);
  const [scrolling, setScrolling] = useState(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !following.current) return;
    el.scrollTop = el.scrollHeight;
    followedTop.current = el.scrollTop;
  }, [trace]);

  useEffect(() => () => clearTimeout(scrollTimer.current), []);

  // The sandbox panel's link to a run: the trace that holds its call opens, and the call scrolls into view
  useEffect(() => {
    function onShow(event: Event) {
      const id = (event as CustomEvent<string>).detail;
      if (!trace.some((item) => item.kind === "tool" && item.step.id === id)) return;
      setOpen(true);
      // After the panel has opened
      setTimeout(() => document.getElementById(`tool-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 400);
    }
    window.addEventListener(SHOW_TOOL_EVENT, onShow);
    return () => window.removeEventListener(SHOW_TOOL_EVENT, onShow);
  }, [trace]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop === followedTop.current) {
      followedTop.current = -1;
      return;
    }
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    showScrollbars();
  }

  // Scrollbars (the area's, and those of wide formulas in it) only show while the user scrolls
  function showScrollbars() {
    setScrolling(true);
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => setScrolling(false), SCROLLBAR_MS);
  }

  return (
    <div className={styles.thinking}>
      {done ? (
        items.length > 0 && (
          <button
            type="button"
            className={styles.thinkingToggle}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronRightIcon className={styles.thinkingChevron} />
            {open ? "Hide thinking" : "Show thinking"}
          </button>
        )
      ) : running ? (
        <div className={styles.thinkingStatus}>
          <ToolStepIcon icon={running.icon} className={`${styles.toolIcon} ${styles.toolIconRunning}`} />
          <span className={styles.toolLabel}>{running.label}</span>
        </div>
      ) : asking ? (
        <div className={styles.thinkingStatus}>
          <WarningIcon className={styles.warnIcon} />
          Paused: waiting for your choice
        </div>
      ) : (
        <div className={styles.thinkingStatus}>
          <span className={styles.spinner} aria-hidden="true" />
          {status && LABELS[status]}
        </div>
      )}
      {items.length > 0 && (
        <div className={`${styles.thinkingPanel} ${expanded ? styles.open : ""}`}>
          <div className={styles.thinkingClip}>
            <div
              ref={scrollRef}
              className={`${styles.thinkingText} ${scrolling ? styles.scrolling : ""}`}
              onScroll={onScroll}
              // A wide formula scrolling sideways; scroll events do not bubble, but can be captured
              onScrollCapture={(e) => e.target !== e.currentTarget && showScrollbars()}
            >
              {items.map((item, i) =>
                item.kind === "tool" ? (
                  <ToolLine key={item.step.id} step={item.step} />
                ) : (
                  <ReasoningText key={`r${i}`} text={item.text} />
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
