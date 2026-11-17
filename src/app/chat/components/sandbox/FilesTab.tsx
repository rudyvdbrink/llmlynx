"use client";

import { useMemo, useRef, useState } from "react";
import styles from "./Sandbox.module.css";
import FilePreview, { fullSizeUrl } from "./FilePreview";
import { TypeIcon } from "../FileCards";
import { ChevronRightIcon, DownloadIcon, ExternalLinkIcon, FolderIcon, TrashIcon, XIcon } from "@/components/icons";
import { baseName, formatSize } from "@/lib/files";
import { clamp, followDrag } from "@/lib/drag";
import type { SandboxFile } from "@/lib/sandbox";

type Folder = { name: string; path: string; folders: Folder[]; files: SandboxFile[] };

// What a drag on the divider leaves the tree and the preview at least
const TREE_MIN_PX = 80;
const PREVIEW_MIN_PX = 140;

/** The files as a tree of folders, folders first, each level by name. */
function buildTree(files: SandboxFile[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.find((f) => f.name.toLowerCase() === part.toLowerCase());
      if (!next) {
        next = { name: part, path: folder.path ? `${folder.path}/${part}` : part, folders: [], files: [] };
        folder.folders.push(next);
      }
      folder = next;
    }
    folder.files.push(file);
  }
  const sort = (folder: Folder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "14:02" today, "Nov 15, 14:02" before: short enough for the version list. */
function shortWhen(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function Tree({
  folder,
  depth,
  open,
  toggle,
  selected,
  onSelect,
}: {
  folder: Folder;
  depth: number;
  open: Set<string>;
  toggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const indent = { paddingLeft: 8 + depth * 16 };
  return (
    <>
      {folder.folders.map((child) => {
        const expanded = open.has(child.path);
        return (
          <li key={`d:${child.path}`}>
            <button
              type="button"
              className={styles.treeRow}
              style={indent}
              aria-expanded={expanded}
              onClick={() => toggle(child.path)}
            >
              <ChevronRightIcon size={14} className={`${styles.treeChevron} ${expanded ? styles.treeChevronOpen : ""}`} />
              <FolderIcon size={15} className={styles.treeIcon} />
              <span className={styles.treeName}>{child.name}</span>
            </button>
            {expanded && (
              <ul className={styles.treeList}>
                <Tree folder={child} depth={depth + 1} open={open} toggle={toggle} selected={selected} onSelect={onSelect} />
              </ul>
            )}
          </li>
        );
      })}
      {folder.files.map((file) => {
        const newest = file.versions[0];
        return (
          <li key={`f:${file.path}`}>
            <button
              type="button"
              className={`${styles.treeRow} ${selected === file.path ? styles.treeRowSelected : ""}`}
              style={indent}
              aria-pressed={selected === file.path}
              title={`${file.path} · ${when(newest.createdAt)}`}
              onClick={() => onSelect(file.path)}
            >
              <span className={styles.treeChevronSpace} />
              <TypeIcon name={file.path} className={styles.treeIcon} />
              <span className={styles.treeName}>{baseName(file.path)}</span>
              <span className={styles.treeSize}>{formatSize(newest.size)}</span>
            </button>
          </li>
        );
      })}
    </>
  );
}

/**
 * The sandbox's files as a tree, with sizes (the date shows on hover).
 * Folders open and close with a chevron; only the top level is open at
 * first. A click on a file shows its preview below the tree, which then takes
 * the lower 60% of the panel, or what a drag on the divider between them made
 * of it (`split`, the tree's share); with its older versions, a download and a
 * delete. Another click on the file, or the preview's close button, gives the
 * tree the full height again.
 */
export default function FilesTab({
  files,
  conversationId,
  onChanged,
  split,
  onSplit,
}: {
  files: SandboxFile[];
  conversationId: string;
  onChanged: () => void;
  split: number | null;
  onSplit: (split: number) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const filesRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLUListElement | null>(null);

  const file = files.find((f) => f.path === selected) ?? null;
  const shown = file?.versions.find((v) => v.id === version && !v.deleted) ?? file?.versions.find((v) => !v.deleted) ?? null;

  function toggle(path: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function select(path: string) {
    setSelected((current) => (current === path ? null : path));
    setVersion(null);
  }

  async function remove() {
    if (!file) return;
    if (!window.confirm(`Delete ${file.path} from the sandbox, with all its versions? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/sandbox/files?path=${encodeURIComponent(file.path)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        setSelected(null);
        onChanged();
      }
    } finally {
      setDeleting(false);
    }
  }

  // Moves the divider without a render on every move; the share is kept when it is let go
  function moveDivider(e: React.PointerEvent<HTMLElement>) {
    const box = filesRef.current;
    const tree = treeRef.current;
    if (!box || !tree) return;
    const height = box.clientHeight;
    const start = tree.offsetHeight;
    let share: number | null = null;
    followDrag(
      e,
      "y",
      (delta) => {
        share = clamp(start + delta, TREE_MIN_PX, Math.max(TREE_MIN_PX, height - PREVIEW_MIN_PX)) / height;
        box.style.setProperty("--tree-share", `${share * 100}%`);
      },
      () => share !== null && onSplit(share)
    );
  }

  if (!files.length) return <p className={styles.empty}>No files yet</p>;
  const full = shown && file ? fullSizeUrl(shown.id, file.mimeType) : null;

  return (
    <div
      ref={filesRef}
      className={`${styles.files} ${file ? styles.filesWithPreview : ""}`}
      style={split === null ? undefined : ({ "--tree-share": `${split * 100}%` } as React.CSSProperties)}
    >
      <ul ref={treeRef} className={`${styles.treeList} ${styles.tree}`} aria-label="Files">
        <Tree folder={tree} depth={0} open={open} toggle={toggle} selected={selected} onSelect={select} />
      </ul>
      {file && shown && (
        <section className={styles.preview} aria-label={`Preview of ${file.path}`}>
          <div
            className={styles.divider}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the preview"
            onPointerDown={moveDivider}
          />
          <div className={styles.previewBar}>
            <span className={styles.previewName} title={file.path}>
              {baseName(file.path)}
            </span>
            {file.versions.length > 1 && (
              <select
                className={styles.versions}
                aria-label="Version"
                value={shown.id}
                onChange={(e) => setVersion(e.target.value)}
              >
                {file.versions.map((v, i) => (
                  <option key={v.id} value={v.id} disabled={v.deleted}>
                    {i === 0 ? "Newest" : v.deleted ? "Deleted" : `Version ${file.versions.length - i}`} · {shortWhen(v.createdAt)}
                  </option>
                ))}
              </select>
            )}
            <span className={styles.previewActions}>
              {full && (
                <a className={styles.iconButton} href={full} target="_blank" rel="noopener" title="Open full size" aria-label="Open full size">
                  <ExternalLinkIcon size={15} />
                </a>
              )}
              <a
                className={styles.iconButton}
                href={`/api/attachments/${shown.id}?download=1`}
                download={baseName(file.path)}
                title="Download"
                aria-label="Download"
              >
                <DownloadIcon size={15} />
              </a>
              <button type="button" className={styles.iconButton} onClick={remove} disabled={deleting} title="Delete" aria-label="Delete">
                <TrashIcon size={15} />
              </button>
              <button type="button" className={styles.iconButton} onClick={() => setSelected(null)} title="Close" aria-label="Close the preview">
                <XIcon size={15} />
              </button>
            </span>
          </div>
          <div className={styles.previewBody}>
            <FilePreview key={shown.id} id={shown.id} name={file.path} mimeType={file.mimeType} size={shown.size} />
          </div>
        </section>
      )}
    </div>
  );
}
