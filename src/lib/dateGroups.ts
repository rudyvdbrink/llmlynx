// Groups for the sidebar conversation list, by last activity in local time.
// Conversations older than RECENT_DAYS are only loaded on request.

export const RECENT_DAYS = 90;

const GROUPS = [
  { label: "Today", daysBack: 0 },
  { label: "Yesterday", daysBack: 1 },
  { label: "Last week", daysBack: 7 },
  { label: "Last month", daysBack: 30 },
  { label: "Last 3 months", daysBack: RECENT_DAYS },
];

const OLDER_LABEL = "Older";

/** Local midnight `daysBack` days before today. */
export function startOfDay(daysBack: number, now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
}

/** Splits items, sorted newest first, into consecutive date groups. Empty groups are left out. */
export function groupByDate<T extends { updatedAt: string }>(items: T[], now = new Date()) {
  const starts = GROUPS.map((g) => ({ label: g.label, start: startOfDay(g.daysBack, now).getTime() }));
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const time = new Date(item.updatedAt).getTime();
    const label = starts.find((g) => time >= g.start)?.label ?? OLDER_LABEL;
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
