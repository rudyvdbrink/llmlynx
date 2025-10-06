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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pw }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMsg({ type: "error", text: data?.message || "Signup failed" });
      } else {
        setMsg({ type: "success", text: "Account created. Redirecting..." });
        setTimeout(() => router.push("/dashboard"), 600);
      }
    } catch {
      setMsg({ type: "error", text: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className={styles.card} aria-label="Create an account">
      <h1 className={styles.title}>Create your account</h1>
      <p className={styles.subtitle}>Join and start chatting instantly.</p>

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

        {msg && (
          <p className={msg.type === "error" ? styles.error : styles.success}>
            {msg.text}
          </p>
        )}

        <p className={styles.linkRow}>
          Already have an account?{" "}
          <a className={styles.inlineLink} href="/login">
            Log in
          </a>
        </p>
      </form>
    </section>
  );
}