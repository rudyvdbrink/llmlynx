"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../Chat.module.css";
import { isNarrowViewport, scrollRoom } from "@/lib/viewport";
import { PaperclipIcon, XIcon } from "@/components/icons";
import { acceptAttribute, fileKind, fileProblem, formatSize, MAX_FILES_PER_MESSAGE, type AttachAccept } from "@/lib/files";
import type { SentFile } from "../hooks/useChat";
import { composerDrop } from "../hooks/useAutoScroll";
import { TypeIcon } from "./FileCards";

// How long a note about a file that cannot be attached stays
const NOTE_MS = 5000;

const NOT_CHECKED = "The file could not be checked; try again in a moment";

/**
 * A file in the composer, with a preview of an image. It goes to the server
 * as soon as it is attached and is checked there while the user types (POST
 * /api/uploads): "checking" until the outcome is in, then "ready" (stored as
 * the draft `id`) or "failed" (not stored: `message` says why, such as a
 * virus).
 */
type Attached = {
  key: number;
  file: File;
  preview: string | null;
  status: "checking" | "ready" | "failed";
  id?: string;
  message?: string;
  check: AbortController; // stops the check
};

/** Deletes a draft that will not be sent. Drafts the server still has after a day are deleted there. */
function deleteDraft(id: string) {
  fetch(`/api/uploads/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
}

// The draft lives here rather than in the page, so typing does not re-render
// the message list or the sidebar. `accept` says which files the chat takes
// (an agent's, `agentId`); null hides the attach button.
export default function Composer({
  isStreaming,
  agentId,
  accept,
  onSend,
  onCancel,
}: {
  isStreaming: boolean;
  agentId: string | null;
  accept: AttachAccept | null;
  onSend: (text: string, files: SentFile[]) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<Attached[]>([]);
  // The files as they are now, for what runs after a check, when `attached` is a render behind
  const filesRef = useRef<Attached[]>([]);
  const nextKey = useRef(0);
  // The user sent while a file was still being checked: the message goes by itself once the outcome is in
  const [waiting, setWaiting] = useState(false);
  const waitingRef = useRef(false);
  const [note, setNote] = useState<string | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const canAttach = !!accept && !!agentId && (accept.documents || accept.images);

  // Auto-resize. Above where it can drop to (see Chat.module.css), the composer
  // would grow downward with the page; the page scrolls along, so it grows upward.
  useEffect(() => {
    const ta = textAreaRef.current;
    if (!ta) return;
    const fromEnd = scrollRoom() - window.scrollY;
    ta.style.height = "0px";
    ta.style.height = Math.min(200, ta.scrollHeight) + "px";
    if (fromEnd < composerDrop(ta)) window.scrollTo(0, scrollRoom() - fromEnd);
  }, [input]);

  // The on-screen keyboard shortens the viewport (see the chat layout). While the
  // textarea has focus, scroll down by the same amount, so the messages just above
  // the composer stay in view instead of sliding under it. When the keyboard
  // closes, the browser itself keeps the page end in place.
  useEffect(() => {
    let height = window.innerHeight;
    function onResize() {
      const shrunk = height - window.innerHeight;
      height = window.innerHeight;
      if (shrunk > 0 && document.activeElement === textAreaRef.current) window.scrollBy(0, shrunk);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The textarea is disabled while streaming and loses focus. Give it back when
  // the reply completes (not on mobile, where focus opens the keyboard).
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    const ta = textAreaRef.current;
    if (wasStreaming.current && !isStreaming && ta && !isNarrowViewport()) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

  // When the composer goes: free the previews, which are the browser's own copies
  // of the images, stop the checks, and delete the drafts that were not sent
  useEffect(
    () => () => {
      clearTimeout(noteTimer.current);
      for (const a of filesRef.current) {
        a.check.abort();
        if (a.preview) URL.revokeObjectURL(a.preview);
        if (a.id) deleteDraft(a.id);
      }
    },
    []
  );

  function setFiles(files: Attached[]) {
    filesRef.current = files;
    setAttached(files);
  }

  function showNote(text: string) {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), NOTE_MS);
  }

  /** Sends the file to the server, which checks it, and shows the outcome on its chip. */
  async function checkFile(item: Attached) {
    let outcome: Partial<Attached>;
    try {
      const form = new FormData();
      form.append("file", item.file, item.file.name);
      form.append("agentId", agentId ?? "");
      const res = await fetch("/api/uploads", { method: "POST", body: form, signal: item.check.signal });
      const data = (await res.json().catch(() => null)) as { outcome?: string; id?: string; message?: string } | null;
      if (res.ok && data?.outcome === "clean" && data.id) outcome = { status: "ready", id: data.id };
      else outcome = { status: "failed", message: data?.message || NOT_CHECKED };
    } catch {
      outcome = { status: "failed", message: NOT_CHECKED };
    }
    // Removed while it was checked: its draft goes too
    if (!filesRef.current.some((a) => a.key === item.key)) {
      if (outcome.id) deleteDraft(outcome.id);
      return;
    }
    setFiles(filesRef.current.map((a) => (a.key === item.key ? { ...a, ...outcome } : a)));
    sendIfWaiting();
  }

  /** Adds the files the chat takes, and starts their checks; says why the first other one cannot be added. */
  function addFiles(files: File[]) {
    if (!accept || !files.length) return;
    const room = MAX_FILES_PER_MESSAGE - filesRef.current.length;
    const problems: string[] = [];
    const added: Attached[] = [];
    for (const file of files) {
      const problem = fileProblem(accept, file);
      if (problem) problems.push(problem);
      else if (added.length < room) {
        added.push({
          key: nextKey.current++,
          file,
          preview: fileKind(file.name) === "image" ? URL.createObjectURL(file) : null,
          status: "checking",
          check: new AbortController(),
        });
      } else problems.push(`At most ${MAX_FILES_PER_MESSAGE} files per message`);
    }
    if (added.length) setFiles([...filesRef.current, ...added]);
    for (const item of added) void checkFile(item);
    if (problems.length) showNote(problems[0]);
  }

  function removeFile(key: number) {
    const gone = filesRef.current.find((a) => a.key === key);
    if (!gone) return;
    gone.check.abort();
    if (gone.preview) URL.revokeObjectURL(gone.preview);
    if (gone.id) deleteDraft(gone.id);
    setFiles(filesRef.current.filter((a) => a.key !== key));
    sendIfWaiting();
  }

  /** The message goes with the files that are stored; one that failed its check stays behind. */
  function sendNow() {
    const text = textAreaRef.current?.value.trim() ?? "";
    const files = filesRef.current;
    const sent: SentFile[] = files.flatMap((a) => (a.status === "ready" && a.id ? [{ id: a.id, file: a.file }] : []));
    if (!text && !sent.length) return;
    setInput("");
    // The sent message shows its files from copies of its own
    for (const a of files) if (a.preview) URL.revokeObjectURL(a.preview);
    setFiles([]);
    setNote(null);
    // Close the on-screen keyboard now, so the viewport does not resize while the reply streams in
    textAreaRef.current?.blur();
    onSend(text, sent);
  }

  /** After a check: sends the message the user already sent, unless an error needs them first. */
  function sendIfWaiting() {
    if (!waitingRef.current || filesRef.current.some((a) => a.status === "checking")) return;
    waitingRef.current = false;
    setWaiting(false);
    if (!filesRef.current.some((a) => a.status === "failed")) sendNow();
  }

  function submit() {
    const files = filesRef.current;
    if (isStreaming || waiting) return;
    if (!input.trim() && !files.some((a) => a.status === "ready" || a.status === "checking")) return;
    if (files.some((a) => a.status === "checking")) {
      waitingRef.current = true;
      setWaiting(true);
      return;
    }
    sendNow();
  }

  const sendable = !!input.trim() || attached.some((a) => a.status === "ready" || a.status === "checking");

  return (
    <form
      className={`${styles.composer} ${attached.length || note ? styles.composerWithFiles : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={(e) => {
        if (canAttach && !isStreaming && e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!canAttach || isStreaming || !e.dataTransfer.files.length) return;
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {(attached.length > 0 || note) && (
        <div className={styles.attachedFiles}>
          {attached.map((a) => (
            <span
              key={a.key}
              className={`${styles.attachedFile} ${a.status === "failed" ? styles.attachedFailed : ""}`}
              title={a.status === "failed" ? `${a.file.name}: ${a.message}` : a.file.name}
            >
              {a.preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- the browser's copy of the user's image
                <img src={a.preview} alt="" className={styles.attachedThumb} />
              ) : (
                <TypeIcon name={a.file.name} className={styles.attachedIcon} />
              )}
              <span className={styles.attachedName}>{a.file.name}</span>
              {a.status === "checking" ? (
                <span className={styles.attachedChecking} role="status">
                  <span className={styles.spinner} aria-hidden="true" />
                  Checking…
                </span>
              ) : a.status === "failed" ? (
                <span className={styles.attachedError} role="alert">
                  {a.message}
                </span>
              ) : (
                <span className={styles.attachedSize}>{formatSize(a.file.size)}</span>
              )}
              <button
                type="button"
                className={styles.attachedRemove}
                aria-label={`Remove ${a.file.name}`}
                onClick={() => removeFile(a.key)}
                disabled={isStreaming}
              >
                <XIcon size={14} />
              </button>
            </span>
          ))}
          {note && (
            <span className={styles.attachNote} role="status">
              {note}
            </span>
          )}
        </div>
      )}
      <textarea
        ref={textAreaRef}
        value={input}
        disabled={isStreaming}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter adds a newline. Ignore Enter while an IME is composing.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={(e) => {
          // Pasted files, such as a screenshot, are attached
          if (!canAttach || !e.clipboardData.files.length) return;
          e.preventDefault();
          addFiles([...e.clipboardData.files]);
        }}
        placeholder={isStreaming ? "Model is responding..." : "Ask the llynx..."}
        aria-label="Message"
        rows={1}
      />
      {canAttach && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={acceptAttribute(accept!)}
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              // So that picking the same file again also counts
              e.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            className={styles.iconButton}
            disabled={isStreaming}
            onClick={() => fileInputRef.current?.click()}
          >
            <PaperclipIcon size={20} />
          </button>
        </>
      )}
      {isStreaming ? (
        <button
          type="button"
          aria-label="Stop response"
          className={`${styles.stopButton} ${styles.iconButton}`}
          onClick={onCancel}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="7" y="7" width="10" height="10" rx="1" />
          </svg>
        </button>
      ) : waiting ? (
        // Sent while a file was still being checked: it goes by itself when the check is done
        <button
          type="button"
          aria-label="Sending when the file is checked"
          title="Sending when the file is checked"
          disabled
          className={styles.iconButton}
        >
          <span className={styles.spinner} aria-hidden="true" />
        </button>
      ) : (
        <button type="submit" aria-label="Send" disabled={!sendable} className={styles.iconButton}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 12L20 4L12 20L11 13L4 12Z" transform="translate(-0.5 0)" />
          </svg>
        </button>
      )}
    </form>
  );
}
