// The host of a URL, as the audit log and the dialogs name where content came from.

/** The host of a URL, for the audit log and the dialogs; null when it is not a URL. */
export function hostOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    return new URL(raw.trim()).hostname || null;
  } catch {
    return null;
  }
}
