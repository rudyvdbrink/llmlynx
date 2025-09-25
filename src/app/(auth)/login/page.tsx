"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../auth.module.css";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // TODO: Replace with real authentication
    router.push("/chat");
  }

  return (
    <main className={styles.container}>
      <section className={styles.card} aria-label="Login">
        <h1 className={styles.title}>Welcome back</h1>
        <p className={styles.subtitle}>Log in to continue</p>

        <form className={styles.form} onSubmit={onSubmit}>
          <label className={styles.label} htmlFor="email">Email</label>
          <input
            id="email"
            className={styles.input}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />

          <label className={styles.label} htmlFor="password">Password</label>
          <input
            id="password"
            className={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />

          <button className={styles.button} type="submit">Log in</button>
        </form>

        <div className={styles.linkRow}>
          New here?{" "}
          <Link className={styles.link} href="/signup">Create an account</Link>
        </div>
      </section>
    </main>
  );
}