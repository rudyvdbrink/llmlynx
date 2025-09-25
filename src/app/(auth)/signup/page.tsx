"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../auth.module.css";
import Link from "next/link";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // TODO: Replace with real sign-up logic
    router.push("/chat");
  }

  return (
    <main className={styles.container}>
      <section className={styles.card} aria-label="Sign up">
        <h1 className={styles.title}>Create your account</h1>
        <p className={styles.subtitle}>It only takes a minute</p>

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
            autoComplete="new-password"
            required
          />

          <button className={styles.button} type="submit">Sign up</button>
        </form>

        <div className={styles.linkRow}>
          Already have an account?{" "}
          <Link className={styles.link} href="/login">Log in</Link>
        </div>
      </section>
    </main>
  );
}