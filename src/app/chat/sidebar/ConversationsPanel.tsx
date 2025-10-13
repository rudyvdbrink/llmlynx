"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Sidebar.module.css";

type ConversationItem = {
  id: string;
  title: string | null;
  updatedAt: string;
  model: string | null;
};

export default function ConversationsPanel({
  collapsed,
  conversations,
  activeConversationId,
  onNewConversation,
  onOpenConversation,
  onRenameConversation,
  onDeleteConversation,
}: {
  collapsed: boolean;
  conversations: ConversationItem[];
  activeConversationId: string | null;
  onNewConversation: () => void;
  onOpenConversation: (id: string) => void;
  onRenameConversation?: (id: string, newTitle: string) => Promise<void> | void;
  onDeleteConversation?: (id: string) => Promise<void> | void;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const [overflowIds, setOverflowIds] = useState<Set<string>>(new Set());
  const [menuState, setMenuState] = useState<{ id: string; anchorRect: DOMRect } | null>(null);

  // Measure overflow to toggle fade on titles that exceed width
  useEffect(() => {
    const measure = () => {
      const next = new Set<string>();
      const root = listRef.current;
      if (!root) {
        setOverflowIds(next);
        return;
      }
      const spans = root.querySelectorAll<HTMLElement>('[data-convo-title="true"]');
      spans.forEach((el) => {
        const id = el.dataset.id;
        if (!id) return;
        if (el.scrollWidth - el.clientWidth > 1) next.add(id);
      });
      setOverflowIds(next);
    };

    const rAF = requestAnimationFrame(measure);
    const t = setTimeout(measure, 0);
    window.addEventListener("resize", measure);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && listRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(listRef.current);
    }

    return () => {
      cancelAnimationFrame(rAF);
      clearTimeout(t);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [conversations, collapsed]);

  // Close menu on outside click, scroll, resize, or Escape
  useEffect(() => {
    if (!menuState) return;

    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const inAnchor = target.closest(`[data-menu-root="${menuState.id}"]`);
      const inMenu = target.closest(`[data-global-menu="${menuState.id}"]`);
      if (!inAnchor && !inMenu) setMenuState(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuState(null);
    };
    const onScrollOrResize = () => setMenuState(null);

    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [menuState]);

  function computeMenuPosition(anchorRect: DOMRect) {
    const MARGIN = 6;
    const EST_W = 200;
    const EST_H = 120;

    let top = anchorRect.bottom + MARGIN;
    if (top + EST_H > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, anchorRect.top - EST_H - MARGIN);
    }

    // Right-align with the button, clamp to viewport
    let left = Math.min(
      window.innerWidth - MARGIN - EST_W,
      Math.max(MARGIN, anchorRect.right - EST_W)
    );

    return { top, left };
  }

  function handleRename(id: string) {
    if (!onRenameConversation) return;
    const current = conversations.find((c) => c.id === id)?.title ?? "Untitled";
    const next = window.prompt("Edit conversation title:", current);
    if (next == null) return; // cancelled
    const title = next.trim();
    if (!title || title === current) {
      setMenuState(null);
      return;
    }
    Promise.resolve(onRenameConversation(id, title)).finally(() => setMenuState(null));
  }

  function handleDelete(id: string) {
    if (!onDeleteConversation) return;
    const ok = window.confirm(
      "Delete this conversation and all of its messages? This cannot be undone."
    );
    if (!ok) return;
    Promise.resolve(onDeleteConversation(id)).finally(() => setMenuState(null));
  }

  function toggleMenuFor(id: string, btnEl: HTMLElement) {
    if (menuState?.id === id) {
      setMenuState(null);
      return;
    }
    setMenuState({ id, anchorRect: btnEl.getBoundingClientRect() });
  }

  const menuPos = menuState ? computeMenuPosition(menuState.anchorRect) : null;

  return (
    <div>
      <div className={styles.sidebarTitleRow}>
        <p className={styles.sidebarTitle}>Conversations</p>
        <button type="button" className={styles.inlineLink} onClick={onNewConversation}>
          + New
        </button>
      </div>

      <ul className={styles.conversationList} aria-label="Conversations" ref={listRef}>
        {conversations.map((c) => {
          const isActive = c.id === activeConversationId;
          const fade = overflowIds.has(c.id);
          const isOpen = menuState?.id === c.id;
          return (
            <li key={c.id}>
              <div
                className={`${styles.conversationItem} ${isActive ? styles.active : ""}`}
                data-menu-root={c.id}
              >
                <button
                  type="button"
                  className={styles.conversationMainBtn}
                  onClick={() => onOpenConversation(c.id)}
                  title={c.title ?? "Untitled"}
                >
                  <span
                    className={`${styles.conversationTitle} ${fade ? styles.conversationTitleFade : ""}`}
                    data-convo-title="true"
                    data-id={c.id}
                  >
                    {c.title ?? "Untitled"}
                  </span>
                </button>

                <button
                  type="button"
                  className={styles.kebabBtn}
                  aria-haspopup="menu"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? `menu-${c.id}` : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleMenuFor(c.id, e.currentTarget);
                  }}
                  title="More options"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <circle cx="5" cy="12" r="2" />
                    <circle cx="12" cy="12" r="2" />
                    <circle cx="19" cy="12" r="2" />
                  </svg>
                </button>
              </div>
            </li>
          );
        })}
        {conversations.length === 0 && (
          <li className={styles.emptyNote}>No conversations yet</li>
        )}
      </ul>

      {/* Global portal menu to avoid clipping by the sidebar */}
      {menuState &&
        menuPos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="menu"
            id={`menu-${menuState.id}`}
            className={styles.menu}
            data-global-menu={menuState.id}
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => handleRename(menuState.id)}
            >
              Edit title
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${styles.menuItem} ${styles.menuDanger}`}
              onClick={() => handleDelete(menuState.id)}
            >
              Delete chat
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}