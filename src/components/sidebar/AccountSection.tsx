import styles from "./Sidebar.module.css";
import type { SessionUser } from "@/lib/types";

export default function AccountSection({ user }: { user: SessionUser }) {
  return (
    <div>
      <p className={styles.sidebarTitle}>Account</p>
      <p className={styles.userEmail}>
        Logged in as:{" "}
        <a href="/account" className={styles.userEmailLink} title="Account settings">
          {user.email}
        </a>
      </p>
    </div>
  );
}
