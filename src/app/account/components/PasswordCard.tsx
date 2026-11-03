"use client";

import { useState } from "react";
import styles from "../Account.module.css";
import StatusLine, { type Status } from "./StatusLine";
import { MIN_PASSWORD_LENGTH } from "@/lib/authRules";

export default function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

    if (pw !== pw2) {
      setStatus({ kind: "error", msg: "New passwords do not match" });
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: pw }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setStatus({ kind: "error", msg: data?.message || "Password change failed" });
      } else {
        setCurrent("");
        setPw("");
        setPw2("");
        setStatus({ kind: "success", msg: "Password changed. Other devices have been logged out." });
      }
    } catch {
      setStatus({ kind: "error", msg: "Network error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="password-title">
      <h2 id="password-title" className={styles.sectionTitle}>
        Change password
      </h2>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.field}>
          <label htmlFor="current-password" className={styles.label}>
            Current password
          </label>
          <input
            id="current-password"
            className={styles.input}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="new-password" className={styles.label}>
            New password
          </label>
          <input
            id="new-password"
            className={styles.input}
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="confirm-password" className={styles.label}>
            Confirm new password
          </label>
          <input
            id="confirm-password"
            className={styles.input}
            type="password"
            autoComplete="new-password"
            placeholder="Repeat new password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className={styles.formActions}>
          <button
            type="submit"
            className={styles.primaryBtn}
            disabled={busy || !current || pw.length < MIN_PASSWORD_LENGTH || pw2.length < MIN_PASSWORD_LENGTH}
          >
            {busy ? "Changing..." : "Change password"}
          </button>
        </div>
      </form>
      <StatusLine status={status} />
    </section>
  );
}
