"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Sidebar.module.css";
import { PencilIcon, PinIcon, PinOffIcon, SearchIcon, TrashIcon } from "@/components/icons";
import type { ConversationList } from "@/hooks/useConversationList";
import { groupByDate } from "@/lib/dateGroups";

export default function ConversationsPanel({
  collapsed,
  conversationList,
  activeConversationId,
  onNewConversation,
  onOpenConversation,
  onRenameConversation,
  onDeleteConversation,
}: {
  collapsed: boolean;
  conversationList: ConversationList;
  activeConversationId: string | null;
  onNewConversation: () => void;
  onOpenConversation: (id: string) => void;
  onRenameConversation?: (id: string, newTitle: string) => Promise<void> | void;
  onDeleteConversation?: (id: string) => Promise<void> | void;
}) {
  const { conversations, hasOlder, loading, query, setQuery, loadOlder, setPinned } = conversationList;
  // Pinned conversations come first from the API and get their own group.
  const groups = useMemo(() => {
    const pinned = conversations.filter((c) => c.pinnedAt);
    const rest = groupByDate(conversations.filter((c) => !c.pinnedAt));
    return pinned.length > 0 ? [{ label: "Pinned", items: pinned }, ...rest] : rest;
  }, [conversations]);
  const listRef = useRef<HTMLDivElement | null>(null);
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
    const left = Math.min(
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

  function handlePin(id: string) {
    const pinned = !!conversations.find((c) => c.id === id)?.pinnedAt;
    Promise.resolve(setPinned(id, !pinned)).finally(() => setMenuState(null));
  }

  function toggleMenuFor(id: string, btnEl: HTMLElement) {
    if (menuState?.id === id) {
      setMenuState(null);
      return;
    }
    setMenuState({ id, anchorRect: btnEl.getBoundingClientRect() });
  }

  const menuPos = menuState ? computeMenuPosition(menuState.anchorRect) : null;
  const menuPinned = !!conversations.find((c) => c.id === menuState?.id)?.pinnedAt;

  return (
    <div>
      {/* Stays at the top while the list scrolls */}
      <div className={styles.conversationsHeader}>
        <div className={styles.sidebarTitleRow}>
          <p className={styles.sidebarTitle}>Conversations</p>
          <button type="button" className={styles.inlineLink} onClick={onNewConversation}>
            + New
          </button>
        </div>
        <div className={styles.conversationSearchBox}>
          <SearchIcon className={styles.conversationSearchIcon} />
          <input
            type="search"
            className={styles.conversationSearch}
            aria-label="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>

      <div ref={listRef}>
        {groups.map((group) => (
          <section key={group.label} className={styles.conversationGroup}>
            <p className={styles.groupLabel}>{group.label}</p>
            <ul className={styles.conversationList} aria-label={group.label}>
              {group.items.map((c) => {
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
            </ul>
          </section>
        ))}
      </div>

      {conversations.length === 0 && !loading && (
        <p className={styles.emptyNote}>
          {query.trim() ? "No matching conversations" : hasOlder ? "No recent conversations" : "No conversations yet"}
        </p>
      )}

      {hasOlder && (
        <button type="button" className={styles.loadOlder} onClick={loadOlder} disabled={loading}>
          {loading ? "Loading…" : query.trim() ? "Load older matches" : "Load older conversations"}
        </button>
      )}

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
              onClick={() => handlePin(menuState.id)}
            >
              {menuPinned ? <PinOffIcon className={styles.menuIcon} /> : <PinIcon className={styles.menuIcon} />}
              {menuPinned ? "Unpin" : "Pin"}
            </button>
            {onRenameConversation && (
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => handleRename(menuState.id)}
              >
                <PencilIcon className={styles.menuIcon} />
                Edit title
              </button>
            )}
            {onDeleteConversation && (
              <button
                type="button"
                role="menuitem"
                className={`${styles.menuItem} ${styles.menuDanger}`}
                onClick={() => handleDelete(menuState.id)}
              >
                <TrashIcon className={styles.menuIcon} />
                Delete chat
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}