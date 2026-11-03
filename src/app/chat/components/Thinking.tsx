"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "../Chat.module.css";
import { ChevronRightIcon } from "@/components/icons";
import ReasoningText from "./ReasoningText";
import type { ReplyStatus } from "@/lib/types";

const LABELS: Record<ReplyStatus, string> = { loading: "Loading model…", thinking: "Thinking…" };

// How long the scrollbar stays visible after the user stops scrolling
const SCROLLBAR_MS = 1000;

/**
 * Shows what the model does before its reply starts: a spinner with "Loading
 * model…" or "Thinking…" (only the spinner while `status` is null), and the
 * reasoning as it streams in, in a short area that keeps its end in view.
 * Once the reply starts (`status` "done"), the reasoning folds away behind a
 * "Show thinking" toggle.
 *
 * Reasoning is rendered as markdown, prepared so that what models do not mean
 * as formatting (such as "2*3") stays as written; see ReasoningText.tsx.
 */
export default function Thinking({ text, status }: { text: string; status: ReplyStatus | "done" | null }) {
  const done = status === "done";
  const [open, setOpen] = useState(false);
  const expanded = !done || open;

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
  }, [text]);

  useEffect(() => () => clearTimeout(scrollTimer.current), []);

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
        <button
          type="button"
          className={styles.thinkingToggle}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronRightIcon className={styles.thinkingChevron} />
          {open ? "Hide thinking" : "Show thinking"}
        </button>
      ) : (
        <div className={styles.thinkingStatus}>
          <span className={styles.spinner} aria-hidden="true" />
          {status && LABELS[status]}
        </div>
      )}
      {text && (
        <div className={`${styles.thinkingPanel} ${expanded ? styles.open : ""}`}>
          <div className={styles.thinkingClip}>
            <div
              ref={scrollRef}
              className={`${styles.thinkingText} ${scrolling ? styles.scrolling : ""}`}
              onScroll={onScroll}
              // A wide formula scrolling sideways; scroll events do not bubble, but can be captured
              onScrollCapture={(e) => e.target !== e.currentTarget && showScrollbars()}
            >
              <ReasoningText text={text} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
