"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./AppShell.module.css";
import boxStyles from "./BoxButton.module.css";
import { ChevronRightIcon, DunesIcon, RobotIcon, SpeechBubbleIcon, SpeechBubblePlusIcon } from "./icons";
import Sidebar, { linksToAgents, type SidebarProps } from "./sidebar/Sidebar";
import { isSidebarOverlay, scrollRoom } from "@/lib/viewport";
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
// The banner's height (--banner-height), and how far the page scrolls before it
// slides away or back
const BANNER_PX = 52;
const SCROLL_SLACK_PX = 10;

/**
 * Page frame with the collapsible sidebar. On wide screens the page makes room
 * for it; on small screens it opens over the page, and a backdrop closes it on
 * tap. `right` is the panel on the right, when there is one (the chat's
 * sandbox panel), for which the page makes room on screens from 1200px. From
 * 861px a drag on the inner edge of either changes its width, until the page
 * reloads.
 *
 * Up to 860px a banner at the top has the buttons that open the sidebar,
 * start a new conversation, open the panel on the right, and follow the
 * sidebar's footer link (to the agents page, or back to the chat); the sidebar
 * and the panel open below it. Opening the sidebar there closes the panel, which would cover it.
 * The banner slides away while the page scrolls down.
 */
export default function AppShell({
  sidebar,
  right,
  children,
}: {
  sidebar: Omit<SidebarProps, "collapsed" | "onToggle">;
  right?: { open: boolean; onOpenChange: (open: boolean) => void };
  children: React.ReactNode;
}) {
  const rightOpen = !!right?.open;
  const [collapsed, setCollapsed] = useState(false);
  const pageRef = useRef<HTMLElement | null>(null);
  const footerLink = !!sidebar.footerNavHref && !!sidebar.footerNavLabel;

  // The viewport width is unknown during server rendering, so the server always
  // renders the sidebar expanded and this corrects it once after hydration.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isSidebarOverlay()) setCollapsed(true);
  }, []);

  // While the panel on the right is open, the page under it keeps its place
  // (on phones, where the panel covers it; see AppShell.module.css)
  useEffect(() => {
    if (!rightOpen) return;
    const html = document.documentElement;
    html.setAttribute("data-right-open", "");
    return () => html.removeAttribute("data-right-open");
  }, [rightOpen]);

  // The banner slides out of view while the page scrolls down, by the user or a
  // reply that follows, and back on a scroll up or near the top. It stays while
  // the sidebar or the panel, which open below it, are open.
  const [bannerAway, setBannerAway] = useState(false);
  useEffect(() => {
    let from = window.scrollY;
    function onScroll() {
      const y = window.scrollY;
      // Moving up to the end is the page getting shorter, or bouncing back on a touch screen
      const settled = y < from && y >= scrollRoom() - 1;
      if (y <= BANNER_PX) setBannerAway(false);
      else if (Math.abs(y - from) < SCROLL_SLACK_PX) return;
      else if (!settled) setBannerAway(y > from);
      from = y;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function toggleFromBanner() {
    if (collapsed) right?.onOpenChange(false);
    setCollapsed(!collapsed);
  }

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
      <header className={`${styles.banner} ${bannerAway && collapsed && !rightOpen ? styles.bannerAway : ""}`}>
        <button
          type="button"
          className={boxStyles.box}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={toggleFromBanner}
        >
          <ChevronRightIcon className={`${boxStyles.icon} ${styles.bannerChevron}`} />
        </button>
        <button type="button" className={boxStyles.box} aria-label="New conversation" onClick={sidebar.onNewConversation}>
          <SpeechBubblePlusIcon className={boxStyles.icon} />
        </button>
        {(right || footerLink) && (
          <div className={styles.bannerEnd}>
            {right && (
              <button
                type="button"
                className={`${boxStyles.box} ${boxStyles.filled}`}
                aria-label={right.open ? "Close the sandbox" : "Open the sandbox"}
                aria-expanded={right.open}
                onClick={() => right.onOpenChange(!right.open)}
              >
                <DunesIcon className={boxStyles.icon} />
              </button>
            )}
            {footerLink && (
              <a href={sidebar.footerNavHref} className={boxStyles.box} aria-label={sidebar.footerNavLabel}>
                {linksToAgents(sidebar.footerNavHref) ? (
                  // Drawn smaller in its box than the other icons, so a size up
                  <RobotIcon size={20} />
                ) : (
                  <SpeechBubbleIcon className={boxStyles.icon} />
                )}
              </a>
            )}
          </div>
        )}
      </header>

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
