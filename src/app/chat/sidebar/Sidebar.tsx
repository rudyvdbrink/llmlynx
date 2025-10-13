"use client";

import styles from "./Sidebar.module.css";
import AccountSection from "./AccountSection";
import ModelSection from "./ModelSection";
import ConversationsPanel from "./ConversationsPanel";

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

  onRenameConversation?: (id: string, newTitle: string) => Promise<void> | void;
  onDeleteConversation?: (id: string) => Promise<void> | void;
}

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
        <AccountSection user={user} />

        <div className={styles.divider} role="separator" aria-orientation="horizontal" />

        <ModelSection
          model={model}
          onChangeModel={onChangeModel}
          disabled={modelDisabled}
        />

        <div className={styles.divider} role="separator" aria-orientation="horizontal" />

        <ConversationsPanel
          collapsed={collapsed}
          conversations={conversations}
          activeConversationId={activeConversationId ?? null}
          onNewConversation={onNewConversation}
          onOpenConversation={onOpenConversation}
          onRenameConversation={onRenameConversation}
          onDeleteConversation={onDeleteConversation}
        />
      </div>
    </aside>
  );
}