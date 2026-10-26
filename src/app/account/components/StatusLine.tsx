import styles from "../Account.module.css";

// Result of the last action in a card. "warning": it worked, with a caveat.
export type Status = { kind: "success" | "warning" | "error"; msg: string };

const KIND_CLASS = {
  success: styles.statusSuccess,
  warning: styles.statusWarning,
  error: styles.statusError,
};

export default function StatusLine({ status }: { status: Status | null }) {
  if (!status) return null;
  return (
    <p role="status" aria-live="polite" className={`${styles.status} ${KIND_CLASS[status.kind]}`}>
      {status.msg}
    </p>
  );
}
