"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../auth.module.css";

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: "error" | "success"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pw }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMsg({ type: "error", text: data?.message || "Invalid credentials" });
      } else {
        setMsg({ type: "success", text: "Logged in. Redirecting..." });
        setTimeout(() => router.push("/chat"), 500);
      }
    } catch {
      setMsg({ type: "error", text: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className={styles.card} aria-label="Log in">
      <h1 className={styles.title}>Welcome back</h1>
      <p className={styles.subtitle}>Enter your credentials to continue.</p>

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
            <label htmlFor="password" className={styles.label}>Password</label>
          </div>
          <input
            id="password"
            className={styles.input}
            type="password"
            required
            autoComplete="current-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Your password"
          />
        </div>

        <p className={styles.linkRow} style={{ marginTop: -2 }}>
          <a className={styles.inlineLink} href="/recovery">
            Forgot password?
          </a>
        </p>

        <button
          type="submit"
          className={styles.button}
          disabled={loading || !email || pw.length === 0}
        >
          {loading ? "Signing in..." : "Log In"}
        </button>

        {msg && (
          <p className={msg.type === "error" ? styles.error : styles.success}>
            {msg.text}
          </p>
        )}

        <p className={styles.linkRow}>
          Need an account?{" "}
          <a className={styles.inlineLink} href="/signup">
            Sign up
          </a>
        </p>
      </form>
    </section>
  );
}