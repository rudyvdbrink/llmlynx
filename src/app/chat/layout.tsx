// Chat-only layout: fixed logo and code highlighting loaded here
import "highlight.js/styles/github-dark-dimmed.min.css";
import styles from "./Chat.module.css";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className={styles.fixedCenterLogo} aria-hidden="true" />
      {children}
    </>
  );
}