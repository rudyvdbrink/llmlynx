"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../Account.module.css";
import StatusLine, { type Status } from "./StatusLine";

export default function DeleteAccountCard() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    const ok = window.confirm(
      "Delete your account with all conversations, agents and API keys? This cannot be undone."
    );
    if (!ok) return;

    setBusy(true);
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setStatus({ kind: "error", msg: data?.message || "Account deletion failed" });
        setBusy(false);
      } else {
        router.replace("/login");
      }
    } catch {
      setStatus({ kind: "error", msg: "Network error" });
      setBusy(false);
    }
  }

  return (
    <section className={`${styles.card} ${styles.dangerCard}`} aria-labelledby="delete-title">
      <h2 id="delete-title" className={styles.sectionTitle}>
        Delete account
      </h2>
      <p className={styles.help}>
        Permanently deletes your account, conversations, agents and saved API keys. Enter your password to confirm.
      </p>
      <form className={styles.inlineForm} onSubmit={submit} noValidate>
        <input
          className={styles.input}
          type="password"
          aria-label="Password"
          placeholder="Your password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className={styles.dangerBtn} disabled={busy || !password}>
          {busy ? "Deleting..." : "Delete account"}
        </button>
      </form>
      <StatusLine status={status} />
    </section>
  );
}
