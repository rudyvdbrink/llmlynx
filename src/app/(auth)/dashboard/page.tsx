import styles from "../auth.module.css";
import { getCurrentUser } from "../../../lib/session";

export default async function DashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <div className={styles.card}>
        <h1 className={styles.title}>Not signed in</h1>
        <p className={styles.subtitle}>
          Please <a className={styles.inlineLink} href="/login">log in</a> or{" "}
          <a className={styles.inlineLink} href="/signup">create an account</a>.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.dashboardWrap}>
      <div className={styles.dashboardCard}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h1 className={styles.title} style={{ margin: 0 }}>Dashboard</h1>
          <span className={styles.badge}>Signed In</span>
        </div>
        <p className={styles.subtitle} style={{ marginBottom: 4 }}>
          Welcome, <strong>{user.email}</strong>
        </p>
        <form className={styles.logoutForm} action="/api/auth/logout" method="POST">
          <button className={styles.button} type="submit">Log Out</button>
        </form>
      </div>
    </div>
  );
}