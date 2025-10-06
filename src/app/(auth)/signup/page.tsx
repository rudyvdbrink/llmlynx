"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../auth.module.css";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (recoveryCode) return; // Prevent double submit after success
    setMsg(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pw }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg({ type: "error", text: data?.message || "Signup failed" });
      } else {
        setRecoveryCode(data.recoveryCode);
        setMsg({
          type: "success",
          text: "Account created. Copy your recovery code below. It will not be shown again."
        });
      }
    } catch {
      setMsg({ type: "error", text: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  function goToDashboard() {
    router.push("/dashboard");
  }

  return (
    <section className={styles.card} aria-label="Create an account">
      <h1 className={styles.title}>Create your account</h1>
      <p className={styles.subtitle}>Join and start chatting instantly.</p>

      <form className={styles.form} onSubmit={submit} noValidate>
        {!recoveryCode && (
          <>
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
                <label htmlFor="password" className={styles.label}>Password</label>
              </div>
              <input
                id="password"
                className={styles.input}
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="At least 8 characters"
              />
            </div>

            <button
              type="submit"
              className={styles.button}
              disabled={loading || !email || pw.length < 8}
            >
              {loading ? "Creating..." : "Sign Up"}
            </button>
          </>
        )}

        {recoveryCode && (
          <div className={styles.fieldGroup} style={{ marginTop: 4 }}>
            <p className={styles.subtitle} style={{ marginBottom: 8 }}>
              This is your recovery code. Store it safely. You will need it to reset your password if you forget it.
            </p>
            <div className={styles.codeBox} aria-label="Recovery code" role="status">
              {recoveryCode}
            </div>
            <button
              type="button"
              onClick={goToDashboard}
              className={styles.button}
              style={{ marginTop: 12 }}
            >
              Go to Dashboard
            </button>
          </div>
        )}

        {msg && (
          <p className={msg.type === "error" ? styles.error : styles.success}>
            {msg.text}
          </p>
        )}

        {!recoveryCode && (
          <p className={styles.linkRow}>
            Already have an account?{" "}
            <a className={styles.inlineLink} href="/login">
              Log in
            </a>
          </p>
        )}
      </form>
    </section>
  );
}