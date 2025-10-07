"use client";

import styles from "./Chat.module.css";

type User = { id: string; email: string } | null;

interface SidebarProps {
  collapsed: boolean;
  onToggle(): void;
  user: User;
  model: string;
  onChangeModel: (value: string) => void;
  modelDisabled?: boolean;
}

export default function Sidebar({
  collapsed,
  onToggle,
  user,
  model,
  onChangeModel,
  modelDisabled
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

        {/* Chat history goes here (tbd) */}
      </div>
    </aside>
  );
}