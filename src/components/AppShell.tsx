"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./AppShell.module.css";
import Sidebar, { type SidebarProps } from "./sidebar/Sidebar";
import { isSidebarOverlay } from "@/lib/viewport";
import { clamp, followDrag } from "@/lib/drag";

// What a drag on a side bar's edge can make of its width. Between the two stays
// at least PAGE_MIN_PX of the page, or OVERLAY_GAP_PX of it while the sandbox
// panel lies over the page (below 1200px).
const SIDEBAR_PX = { min: 240, max: 600 };
const SANDBOX_PX = { min: 320, max: 1000 };
const PAGE_MIN_PX = 360;
const OVERLAY_GAP_PX = 120;
// Matches the 1200px breakpoint in AppShell.module.css
const SANDBOX_BESIDE_MIN_PX = 1200;

/**
 * Page frame with the collapsible sidebar. On wide screens the page makes room
 * for it; on small screens it opens over the page, and a backdrop closes it on
 * tap. `rightOpen` says a panel on the right is open (the chat's sandbox
 * panel), for which the page makes room on screens from 1200px. From 861px a
 * drag on the inner edge of either changes its width, until the page reloads.
 */
export default function AppShell({
  sidebar,
  rightOpen = false,
  children,
}: {
  sidebar: Omit<SidebarProps, "collapsed" | "onToggle">;
  rightOpen?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pageRef = useRef<HTMLElement | null>(null);

  // The viewport width is unknown during server rendering, so the server always
  // renders the sidebar expanded and this corrects it once after hydration.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isSidebarOverlay()) setCollapsed(true);
  }, []);

  // The widths live in --sidebar-width and --sandbox-width on the page, set
  // here without a render, which a drag would otherwise cause on every move.
  function resize(e: React.PointerEvent<HTMLElement>, side: "left" | "right") {
    const page = pageRef.current;
    if (!page) return;
    const width = (name: string) => parseFloat(getComputedStyle(page).getPropertyValue(name));
    const name = side === "left" ? "--sidebar-width" : "--sandbox-width";
    const start = width(name);
    const vw = window.innerWidth;
    // What the other side takes, and what stays free between them
    const other =
      side === "left"
        ? rightOpen ? width("--sandbox-width") : 0
        : collapsed ? width("--sidebar-grip") : width("--sidebar-width");
    const free = rightOpen && vw < SANDBOX_BESIDE_MIN_PX ? OVERLAY_GAP_PX : PAGE_MIN_PX;
    const { min, max } = side === "left" ? SIDEBAR_PX : SANDBOX_PX;
    // A side already wider than there is room for does not jump narrower
    const upper = Math.max(start, Math.min(max, vw - other - free));
    followDrag(e, "x", (delta) => {
      const next = clamp(start + (side === "left" ? delta : -delta), min, upper);
      page.style.setProperty(name, `${Math.round(next)}px`);
    });
  }

  return (
    <main
      ref={pageRef}
      className={`${styles.page} ${collapsed ? "" : styles.sidebarOpen} ${rightOpen ? styles.rightOpen : ""}`}
    >
      {!collapsed && (
        <button
          type="button"
          className={styles.sidebarBackdrop}
          aria-label="Collapse sidebar"
          onClick={() => setCollapsed(true)}
        />
      )}

      <Sidebar {...sidebar} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />

      {!collapsed && (
        <div
          className={`${styles.resizer} ${styles.resizerLeft}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the sidebar"
          onPointerDown={(e) => resize(e, "left")}
        />
      )}
      {rightOpen && (
        <div
          className={`${styles.resizer} ${styles.resizerRight}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the sandbox"
          onPointerDown={(e) => resize(e, "right")}
        />
      )}

      {children}
    </main>
  );
}
