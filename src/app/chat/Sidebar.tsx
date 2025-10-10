"use client";

import styles from "./Chat.module.css";

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
          <p className={styles.modelLabel} id="model-select-label">Model</p>
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
          <ul className={styles.conversationList} aria-label="Conversations">
            {conversations.map((c) => {
              const isActive = c.id === activeConversationId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`${styles.conversationItem} ${isActive ? styles.active : ""}`}
                    onClick={() => onOpenConversation(c.id)}
                    title={c.title ?? "Untitled"}
                  >
                    <span className={styles.conversationTitle}>
                      {c.title ?? "Untitled"}
                    </span>
                    {c.model ? <span className={styles.conversationModel}>{c.model}</span> : null}
                  </button>
                </li>
              );
            })}
            {conversations.length === 0 && (
              <li className={styles.emptyNote}>No conversations yet</li>
            )}
          </ul>
        </div>
      </div>
    </aside>
  );
}