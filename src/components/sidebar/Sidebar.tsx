"use client";

import { useEffect, useRef } from "react";
import styles from "./Sidebar.module.css";
import AccountSection from "./AccountSection";
import ModelSection from "./ModelSection";
import ConversationsPanel from "./ConversationsPanel";
import type { ConversationList } from "@/hooks/useConversationList";
import type { SessionUser } from "@/lib/types";

export interface SidebarProps {
  collapsed: boolean;
  onToggle(): void;
  user: SessionUser;
  model: string;
  onChangeModel: (value: string) => void;
  modelDisabled?: boolean;

  conversationList: ConversationList;
  activeConversationId?: string | null;
  onNewConversation: () => void;
  onOpenConversation: (id: string) => void;

  onRenameConversation?: (id: string, newTitle: string) => Promise<void> | void;
  onDeleteConversation?: (id: string) => Promise<void> | void;

  // Footer navigation button (e.g., to /agents or /chat)
  footerNavLabel?: string;
  footerNavHref?: string;
}

export default function Sidebar({
  collapsed,
  onToggle,
  user,
  model,
  onChangeModel,
  modelDisabled,
  conversationList,
  activeConversationId,
  onNewConversation,
  onOpenConversation,
  onRenameConversation,
  onDeleteConversation,
  footerNavLabel,
  footerNavHref,
}: SidebarProps) {
  // Width of the conversation list's scrollbar, for .sidebarScrollArea
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (el) el.style.setProperty("--scrollbar-width", `${el.offsetWidth - el.clientWidth}px`);
  }, []);

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
        <div className={styles.sidebarHeader}>
          <AccountSection user={user} />

          <div className={styles.divider} role="separator" aria-orientation="horizontal" />

          <ModelSection
            model={model}
            onChangeModel={onChangeModel}
            disabled={modelDisabled}
          />

          <div className={styles.divider} role="separator" aria-orientation="horizontal" />
        </div>

        <div className={styles.sidebarScrollArea} ref={scrollAreaRef}>
          <ConversationsPanel
            collapsed={collapsed}
            conversationList={conversationList}
            activeConversationId={activeConversationId ?? null}
            onNewConversation={onNewConversation}
            onOpenConversation={onOpenConversation}
            onRenameConversation={onRenameConversation}
            onDeleteConversation={onDeleteConversation}
          />
        </div>
      </div>

      {footerNavHref && footerNavLabel && (
        <div className={styles.sidebarFooter}>
          <a href={footerNavHref} className={styles.footerButton}>
            <span className={styles.footerButtonIcon} aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5l8 7-8 7V5z" />
              </svg>
            </span>
            <span className={styles.footerButtonLabel}>{footerNavLabel}</span>
          </a>
        </div>
      )}
    </aside>
  );
}
