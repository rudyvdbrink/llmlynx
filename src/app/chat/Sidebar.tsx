"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Sidebar.module.css";

type User = { id: string; email: string } | null;

type ConversationItem = {
  id: string;
  title: string | null;
  updatedAt: string;
  model: string | null;
};

interface SidebarProps {
  collapsed: boolean;
  onToggle(): void;
  user: User;
  model: string;
  onChangeModel: (value: string) => void;
  modelDisabled?: boolean;

  conversations: ConversationItem[];
  activeConversationId?: string | null;
  onNewConversation: () => void;
  onOpenConversation: (id: string) => void;

  onRenameConversation: (id: string, newTitle: string) => Promise<void> | void;
  onDeleteConversation: (id: string) => Promise<void> | void;
}

type MenuState = {
  id: string;
  anchorRect: DOMRect;
} | null;

export default function Sidebar({
  collapsed,
  onToggle,
  user,
  model,
  onChangeModel,
  modelDisabled,
  conversations,
  activeConversationId,
  onNewConversation,
  onOpenConversation,
  onRenameConversation,
  onDeleteConversation,
}: SidebarProps) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const [overflowIds, setOverflowIds] = useState<Set<string>>(new Set());
  const [menuState, setMenuState] = useState<MenuState>(null);

  // Measure which titles overflow and toggle fade class only for those
  useEffect(() => {
    const measure = () => {
      const next = new Set<string>();
      const root = listRef.current;
      if (root) {
        const spans = root.querySelectorAll<HTMLElement>('[data-convo-title="true"]');
        spans.forEach((el) => {
          const id = el.dataset.id;
          if (!id) return;
          const overflows = el.scrollWidth - el.clientWidth > 1;
          if (overflows) next.add(id);
        });
      }
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

  // Close menu on outside click, Escape, scroll, or resize
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

  function handleRename(c: ConversationItem) {
    const current = c.title ?? "Untitled";
    const next = window.prompt("Edit conversation title:", current);
    if (next == null) return; // cancelled
    const title = next.trim();
    if (!title || title === current) {
      setMenuState(null);
      return;
    }
    Promise.resolve(onRenameConversation(c.id, title)).finally(() => setMenuState(null));
  }

  function handleDelete(c: ConversationItem) {
    const ok = window.confirm("Delete this conversation and all of its messages? This cannot be undone.");
    if (!ok) return;
    Promise.resolve(onDeleteConversation(c.id)).finally(() => setMenuState(null));
  }

  function toggleMenuFor(id: string, btnEl: HTMLElement) {
    if (menuState?.id === id) {
      setMenuState(null);
      return;
    }
    const rect = btnEl.getBoundingClientRect();
    setMenuState({ id, anchorRect: rect });
  }

  function computeMenuPosition(anchorRect: DOMRect) {
    const MARGIN = 6;
    const EST_W = 200;  // estimate, min-width is 180px
    const EST_H = 120;  // estimated vertical space needed

    // Default below the button
    let top = anchorRect.bottom + MARGIN;
    // Flip up if needed
    if (top + EST_H > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, anchorRect.top - EST_H - MARGIN);
    }

    // Align right edge of menu with button's right edge, clamped to viewport
    let left = Math.min(
      window.innerWidth - MARGIN - EST_W,
      Math.max(MARGIN, anchorRect.right - EST_W)
    );

    // If there's ample space to the right, keep right-aligned behavior
    // Otherwise, the clamp above keeps it within viewport.
    return { top, left };
  }

  const menuPos = menuState ? computeMenuPosition(menuState.anchorRect) : null;

  return (
    <aside
      className={`${styles.sidebar} ${collapsed ? styles.collapsed : ""}`}
      aria-label="Chat sidebar"
    >
      <button
        type="button"
        className={styles.sidebarToggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <svg
          className={styles.sidebarToggleIcon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="16 4 8 12 16 20" />
        </svg>
      </button>

      <div className={styles.sidebarContent}>
        {/* Account */}
        <div>
          <p className={styles.sidebarTitle}>Account</p>
          {user ? (
            <p className={styles.userEmail}>
              Logged in as: <span>{user.email}</span>
            </p>
          ) : (
            <p className={styles.userEmail}>
              Not logged in
              <br />
              <a href="/login" className={styles.loginLink}>
                Sign in
              </a>
            </p>
          )}
        </div>

        <div className={styles.divider} role="separator" aria-orientation="horizontal" />

        {/* Model Selection */}
        <div className={styles.modelBlock}>
          <p className={styles.sidebarTitle} id="model-select-label">Model</p>
          <select
            aria-labelledby="model-select-label"
            className={styles.modelSelect}
            value={model}
            onChange={(e) => onChangeModel(e.target.value)}
            disabled={modelDisabled}
          >
            <option value="gpt-oss:20b">gpt-oss:20b</option>
            <option value="gemma3:1b">gemma3:1b</option>
            <option value="gemma3:12b">gemma3:12b</option>
            <option value="mistral">mistral</option>
          </select>
        </div>

        <div className={styles.divider} role="separator" aria-orientation="horizontal" />

        {/* Conversations */}
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
              const menuOpen = menuState?.id === c.id;

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
                      aria-expanded={menuOpen}
                      aria-controls={menuOpen ? `menu-${c.id}` : undefined}
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
        </div>
      </div>

      {/* Global (portal) menu rendered into document.body to avoid clipping */}
      {menuState && menuPos &&
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
              onClick={() => {
                const c = conversations.find((x) => x.id === menuState.id);
                if (c) handleRename(c);
              }}
            >
              Edit title
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${styles.menuItem} ${styles.menuDanger}`}
              onClick={() => {
                const c = conversations.find((x) => x.id === menuState.id);
                if (c) handleDelete(c);
              }}
            >
              Delete chat
            </button>
          </div>,
          document.body
        )}
    </aside>
  );
}