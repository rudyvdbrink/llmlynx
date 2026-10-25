// Chat-only layout: fixed logo and code highlighting loaded here
import type { Viewport } from "next";
import "highlight.js/styles/github-dark-dimmed.min.css";
import "katex/dist/katex.min.css";
import styles from "./Chat.module.css";

// The on-screen keyboard shortens the page instead of covering it, so the
// composer at the bottom stays above the keyboard (Chrome-based browsers on Android).
export const viewport: Viewport = {
  interactiveWidget: "resizes-content",
};

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className={styles.fixedCenterLogo} aria-hidden="true" />
      {children}
    </>
  );
}