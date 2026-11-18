// Line diffs, for what edit_files changed: unified hunks ("@@ -10,3 +10,4 @@",
// then " " context, "-" removed and "+" added lines), at most so many lines.

type Op = { kind: " " | "-" | "+"; line: string };

// Past this many differing lines, the changed part is shown as one block of removed and added lines
const MAX_EDIT_DISTANCE = 500;

/** The shortest edit script from `a` to `b` (Myers), or null when they differ in more than MAX_EDIT_DISTANCE lines. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        // Back through the trace, from the end
        const ops: Op[] = [];
        let [cx, cy] = [n, m];
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd];
          const kk = cx - cy;
          const down = kk === -dd || (kk !== dd && pv[offset + kk - 1] < pv[offset + kk + 1]);
          const pk = down ? kk + 1 : kk - 1;
          const px = pv[offset + pk];
          const py = px - pk;
          while (cx > px && cy > py) {
            ops.push({ kind: " ", line: a[--cx] });
            cy--;
          }
          if (down) ops.push({ kind: "+", line: b[--cy] });
          else ops.push({ kind: "-", line: a[--cx] });
        }
        while (cx > 0 && cy > 0) {
          ops.push({ kind: " ", line: a[--cx] });
          cy--;
        }
        return ops.reverse();
      }
    }
    v = v.slice();
  }
  return null;
}

/** The ops from `a` to `b`: the same lines at the start and the end, and the shortest script in between. */
function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  const mid = myers(midA, midB) ?? [
    ...midA.map((line) => ({ kind: "-" as const, line })),
    ...midB.map((line) => ({ kind: "+" as const, line })),
  ];
  const same = (line: string) => ({ kind: " " as const, line });
  return [...a.slice(0, start).map(same), ...mid, ...a.slice(a.length - end).map(same)];
}

export type DiffSummary = { added: number; removed: number; hunks: string[] };

/** The hunks of the diff from `a` to `b`, with `context` lines around each change, and how many lines it adds and removes. */
export function lineDiff(a: string[], b: string[], context = 2): DiffSummary {
  const ops = diffOps(a, b);
  const changed = ops.map((op, i) => (op.kind === " " ? -1 : i)).filter((i) => i >= 0);
  const hunks: string[] = [];
  let i = 0;
  while (i < changed.length) {
    // A hunk: changes no more than 2 * context lines apart, with their context
    let last = i;
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= 2 * context + 1) last++;
    const from = Math.max(0, changed[i] - context);
    const to = Math.min(ops.length, changed[last] + context + 1);
    let oldLine = 1;
    let newLine = 1;
    for (const op of ops.slice(0, from)) {
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
    }
    const part = ops.slice(from, to);
    const oldCount = part.filter((op) => op.kind !== "+").length;
    const newCount = part.filter((op) => op.kind !== "-").length;
    hunks.push([`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`, ...part.map((op) => `${op.kind}${op.line}`)].join("\n"));
    i = last + 1;
  }
  return {
    added: ops.filter((op) => op.kind === "+").length,
    removed: ops.filter((op) => op.kind === "-").length,
    hunks,
  };
}
