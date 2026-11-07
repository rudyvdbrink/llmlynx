// Checks of the arguments models send to tools, and labels made from them.

const MAX_LABEL_LENGTH = 60;

export function shorten(text: string, max = MAX_LABEL_LENGTH): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Models sometimes send numbers as strings. Returns undefined when `raw` is absent. */
export function toInteger(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

export function checkStart(raw: unknown): { start: number } | { error: string } {
  const start = toInteger(raw);
  if (start === null || (start !== undefined && start < 0)) return { error: "start must be a whole number, 0 or more." };
  return { start: start ?? 0 };
}
