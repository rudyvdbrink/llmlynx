// Chat-only layout: code highlighting and math styles loaded here
import type { Viewport } from "next";
import "highlight.js/styles/github-dark-dimmed.min.css";
import "katex/dist/katex.min.css";

// The on-screen keyboard shortens the page instead of covering it, so the
// composer at the bottom stays above the keyboard (Chrome-based browsers on Android).
export const viewport: Viewport = {
  interactiveWidget: "resizes-content",
};

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return children;
}