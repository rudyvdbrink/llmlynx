"use client";

import styles from "./Sidebar.module.css";

type User = { id: string; email: string } | null;

export default function AccountSection({ user }: { user: User }) {
  return (
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
  );
}