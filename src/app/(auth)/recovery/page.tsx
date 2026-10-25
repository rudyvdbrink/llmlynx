"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../auth.module.css";
import { isRecoveryCode, MIN_PASSWORD_LENGTH, RECOVERY_CODE_LENGTH } from "@/lib/authRules";

export default function RecoveryPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
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
    if (!isRecoveryCode(recoveryCode)) {
      setMsg({ type: "error", text: `Recovery code must be ${RECOVERY_CODE_LENGTH} digits` });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
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
        Enter your email and 12‑digit recovery code, then choose a new password.
      </p>

      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.fieldGroup}>
          <div className={styles.labelRow}>
            <label htmlFor="email" className={styles.label}>Email</label>
          </div>
          <input
            id="email"
            className={styles.input}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>

        <div className={styles.fieldGroup}>
          <div className={styles.labelRow}>
            <label htmlFor="recovery" className={styles.label}>Recovery Code</label>
          </div>
          <input
            id="recovery"
            className={styles.input}
            type="text"
            inputMode="numeric"
            pattern={`[0-9]{${RECOVERY_CODE_LENGTH}}`}
            maxLength={RECOVERY_CODE_LENGTH}
            required
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value.replace(/\D/g, "").slice(0, RECOVERY_CODE_LENGTH))}
            placeholder={`${RECOVERY_CODE_LENGTH} digits`}
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
            minLength={MIN_PASSWORD_LENGTH}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
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
            minLength={MIN_PASSWORD_LENGTH}
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
            !email ||
            recoveryCode.length !== RECOVERY_CODE_LENGTH ||
            pw.length < MIN_PASSWORD_LENGTH ||
            pw2.length < MIN_PASSWORD_LENGTH
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