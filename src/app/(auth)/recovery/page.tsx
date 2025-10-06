"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../auth.module.css";

export default function RecoveryPage() {
  const router = useRouter();
  const [recoveryCode, setRecoveryCode] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: "error" | "success"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);

    if (pw !== pw2) {
      setMsg({ type: "error", text: "Passwords do not match" });
      return;
    }
    if (!/^[0-9]{12}$/.test(recoveryCode)) {
      setMsg({ type: "error", text: "Recovery code must be 12 digits" });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recoveryCode,
          newPassword: pw
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg({ type: "error", text: data?.message || "Recovery failed" });
      } else {
        setMsg({ type: "success", text: "Password updated. Redirecting to login..." });
        setTimeout(() => router.push("/login"), 1200);
      }
    } catch {
      setMsg({ type: "error", text: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className={styles.card} aria-label="Recover account">
      <h1 className={styles.title}>Reset password</h1>
      <p className={styles.subtitle}>
        Enter your 12‑digit recovery code and choose a new password.
      </p>

      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.fieldGroup}>
          <div className={styles.labelRow}>
            <label htmlFor="recovery" className={styles.label}>Recovery Code</label>
          </div>
            <input
              id="recovery"
              className={styles.input}
              type="text"
              inputMode="numeric"
              pattern="[0-9]{12}"
              maxLength={12}
              required
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value.replace(/\D/g, "").slice(0, 12))}
              placeholder="12 digits"
            />
        </div>

        <div className={styles.fieldGroup}>
          <div className={styles.labelRow}>
            <label htmlFor="new-password" className={styles.label}>New Password</label>
          </div>
          <input
            id="new-password"
            className={styles.input}
            type="password"
            required
            minLength={8}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="At least 8 characters"
          />
        </div>

        <div className={styles.fieldGroup}>
          <div className={styles.labelRow}>
            <label htmlFor="confirm-password" className={styles.label}>Confirm Password</label>
          </div>
          <input
            id="confirm-password"
            className={styles.input}
            type="password"
            required
            minLength={8}
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            placeholder="Repeat password"
          />
        </div>

        <button
          type="submit"
          className={styles.button}
          disabled={
            loading ||
            recoveryCode.length !== 12 ||
            pw.length < 8 ||
            pw2.length < 8
          }
        >
          {loading ? "Updating..." : "Reset Password"}
        </button>

        {msg && (
          <p className={msg.type === "error" ? styles.error : styles.success}>
            {msg.text}
          </p>
        )}

        <p className={styles.linkRow}>
          Remembered it?{" "}
          <a className={styles.inlineLink} href="/login">
            Log in
          </a>
        </p>
      </form>
    </section>
  );
}