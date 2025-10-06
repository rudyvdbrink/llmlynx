import React from "react";
import styles from "./auth.module.css";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.container}>
      <div className={styles.logoBackdrop} aria-hidden="true" />
      <div className={styles.vignette} aria-hidden="true" />
      {children}
    </div>
  );
}