"use client";

import { useEffect, useState } from "react";
import styles from "./Sandbox.module.css";
import boxStyles from "@/components/BoxButton.module.css";
import FilesTab from "./FilesTab";
import { useSandbox } from "./useSandbox";
import { showToolCall } from "../Thinking";
import { ChevronRightIcon, DunesIcon, GitBranchIcon, PackageIcon, TerminalIcon, WarningIcon } from "@/components/icons";
import type { SandboxPackageRow, SandboxRunSummary, SandboxView } from "@/lib/sandbox";

type Tab = "files" | "runs" | "packages";

const TABS: { id: Tab; label: string; empty: string }[] = [
  { id: "files", label: "Files", empty: "No files yet" },
  { id: "runs", label: "Runs", empty: "No runs yet" },
  { id: "packages", label: "Packages", empty: "No packages yet" },
];

const LANGUAGES: Record<string, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  shell: "Shell",
  pypi: "PyPI",
  npm: "npm",
  git: "Git",
};

const STATUSES: Record<string, string> = {
  ok: "Succeeded",
  error: "Failed",
  timeout: "Timed out",
  stopped: "Stopped",
  withheld: "Withheld",
  blocked: "Not run",
  skipped: "Not run",
};

// Below this width the panel opens over the chat; matches the 1200px breakpoint in Sandbox.module.css
const BESIDE_MIN_PX = 1200;

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function RunRow({ run, conversationId, onShow }: { run: SandboxRunSummary; conversationId: string; onShow: () => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ code: string; output: string | null } | null>(null);

  useEffect(() => {
    if (!open || detail) return;
    let cancelled = false;
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/sandbox/runs/${encodeURIComponent(run.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => !cancelled && body && setDetail(body));
    return () => {
      cancelled = true;
    };
  }, [open, detail, conversationId, run.id]);

  const failed = run.status !== "ok";
  const changed = run.files?.changed ?? [];
  const deleted = run.files?.deleted ?? [];
  return (
    <li className={styles.run}>
      <button type="button" className={styles.runRow} aria-expanded={open} onClick={() => setOpen((o) => !o)} title={when(run.createdAt)}>
        <ChevronRightIcon size={14} className={`${styles.treeChevron} ${open ? styles.treeChevronOpen : ""}`} />
        {run.kind === "install" ? (
          <PackageIcon size={15} className={styles.treeIcon} />
        ) : run.language === "git" ? (
          <GitBranchIcon size={15} className={styles.treeIcon} />
        ) : (
          <TerminalIcon size={15} className={styles.treeIcon} />
        )}
        <span className={styles.runLanguage}>{LANGUAGES[run.language] ?? run.language}</span>
        <span className={`${styles.runStatus} ${failed ? styles.runFailed : ""}`}>
          {run.status === "withheld" && <WarningIcon size={13} />}
          {STATUSES[run.status] ?? run.status}
        </span>
        <span className={styles.treeSize}>{duration(run.durationMs)}</span>
      </button>
      {open && (
        <div className={styles.runDetail}>
          <h4 className={styles.detailTitle}>{run.kind === "install" ? "Packages" : "Code"}</h4>
          <pre className={styles.detailBox}>{detail ? detail.code || " " : "Loading…"}</pre>
          <h4 className={styles.detailTitle}>{run.kind === "install" ? "Report" : "Output"}</h4>
          {run.status === "withheld" ? (
            <p className={styles.note}>Withheld: it looked like instructions aimed at the model, or could not be checked.</p>
          ) : (
            <pre className={styles.detailBox}>{detail ? detail.output || "(Nothing.)" : "Loading…"}</pre>
          )}
          {run.kind === "run" && (
            <>
              <h4 className={styles.detailTitle}>Files</h4>
              <p className={styles.note}>
                {changed.length || deleted.length
                  ? [...changed.map((p) => `${p}`), ...deleted.map((p) => `${p} (deleted)`)].join(", ")
                  : "None changed."}
              </p>
            </>
          )}
          <button type="button" className={styles.linkButton} onClick={onShow}>
            Show in the chat
          </button>
        </div>
      )}
    </li>
  );
}

function PackagesList({ packages }: { packages: SandboxPackageRow[] }) {
  const groups = ["pypi", "npm"].map((eco) => ({ eco, rows: packages.filter((p) => p.ecosystem === eco) })).filter((g) => g.rows.length);
  return (
    <div className={styles.packages}>
      {groups.map((group) => (
        <section key={group.eco}>
          <h4 className={styles.detailTitle}>{group.eco === "pypi" ? "From PyPI" : "From npm"}</h4>
          <table className={styles.packageTable}>
            <thead>
              <tr>
                <th>Package</th>
                <th>Version</th>
                <th>Installed</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((p) => (
                <tr key={`${p.name}@${p.version}`} className={p.requested ? styles.requested : ""}>
                  <td title={p.requested ? "Asked for" : "Needed by another package"}>{p.name}</td>
                  <td>{p.version}</td>
                  <td>{when(p.installedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function Body({ tab, data, conversationId, reload, onShowRun, split, onSplit, reveal }: {
  tab: Tab;
  data: SandboxView;
  conversationId: string;
  reload: () => void;
  onShowRun: (toolCallId: string) => void;
  split: number | null;
  onSplit: (split: number) => void;
  reveal: { id: string } | null;
}) {
  if (tab === "files") {
    return (
      <FilesTab files={data.files} conversationId={conversationId} onChanged={reload} split={split} onSplit={onSplit} reveal={reveal} />
    );
  }
  if (tab === "runs") {
    if (!data.runs.length) return <p className={styles.empty}>No runs yet</p>;
    return (
      <ul className={styles.runs}>
        {data.runs.map((run) => (
          <RunRow key={run.id} run={run} conversationId={conversationId} onShow={() => onShowRun(run.toolCallId)} />
        ))}
      </ul>
    );
  }
  if (!data.packages.length) return <p className={styles.empty}>No packages yet</p>;
  return <PackagesList packages={data.packages} />;
}

/**
 * The sandbox panel: a side bar on the right of the chat, the counterpart of
 * the sidebar on the left, with the chat's files, runs and packages. Only a
 * chat with a sandbox (`available`) shows its toggle, a box with dunes, which
 * fades in at the right edge; the panel stays collapsed until it is clicked, also
 * while code runs. From 1200px it sits beside the chat, which narrows; below
 * that it opens over the chat, with a backdrop that closes it; on phones it
 * covers the full width. `tick` changes when a run, an install or a download
 * of the reply ends, and the panel loads again. `reveal` is a file a card in
 * the chat asked to show: the files tab shows its preview.
 */
export default function SandboxPanel({
  conversationId,
  available,
  open,
  onOpenChange,
  tick,
  reveal,
}: {
  conversationId: string | null;
  available: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tick: number;
  reveal: { id: string } | null;
}) {
  const [tab, setTab] = useState<Tab>("files");
  const [revealed, setRevealed] = useState(reveal);
  if (reveal !== revealed) {
    setRevealed(reveal);
    if (reveal) setTab("files");
  }
  // The tree's share of the files tab beside a preview, once the divider was dragged; kept until the page reloads
  const [split, setSplit] = useState<number | null>(null);
  const { data, error, reload } = useSandbox(conversationId, open && available, tick);

  if (!available || !conversationId) return null;

  function showRun(toolCallId: string) {
    // Over the chat, the panel would hide what it links to
    if (window.innerWidth < BESIDE_MIN_PX) onOpenChange(false);
    showToolCall(toolCallId);
  }

  return (
    <>
      {open && <button type="button" className={styles.backdrop} aria-label="Close the sandbox" onClick={() => onOpenChange(false)} />}
      <aside className={`${styles.panel} ${open ? styles.open : ""}`} aria-label="Sandbox">
        <button
          type="button"
          className={`${boxStyles.box} ${boxStyles.filled} ${styles.toggle}`}
          aria-label={open ? "Close the sandbox" : "Open the sandbox"}
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <DunesIcon className={boxStyles.icon} />
        </button>
        <div className={styles.content} inert={!open}>
          <header className={styles.header}>
            <h2 className={styles.title}>Sandbox</h2>
          </header>
          <div className={styles.tabs} role="tablist" aria-label="Sandbox">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`${styles.tab} ${tab === t.id ? styles.tabActive : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className={styles.body} role="tabpanel">
            {data ? (
              <Body
                tab={tab}
                data={data}
                conversationId={conversationId}
                reload={reload}
                onShowRun={showRun}
                split={split}
                onSplit={setSplit}
                reveal={reveal}
              />
            ) : (
              <p className={styles.empty}>{error ?? "Loading…"}</p>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
