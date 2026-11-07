"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../Chat.module.css";
import { isNarrowViewport } from "@/lib/viewport";
import { PaperclipIcon, XIcon } from "@/components/icons";
import { acceptAttribute, fileKind, fileProblem, formatSize, MAX_FILES_PER_MESSAGE, type AttachAccept } from "@/lib/files";
import { TypeIcon } from "./FileCards";

// How long a note about a file that cannot be attached stays
const NOTE_MS = 5000;

/** A file waiting to be sent, with a preview of an image. */
type Attached = { file: File; preview: string | null };

// The draft lives here rather than in the page, so typing does not re-render
// the message list or the sidebar. `accept` says which files the chat takes
// (an agent's); null hides the attach button.
export default function Composer({
  isStreaming,
  accept,
  onSend,
  onCancel,
}: {
  isStreaming: boolean;
  accept: AttachAccept | null;
  onSend: (text: string, files: File[]) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<Attached[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const canAttach = !!accept && (accept.documents || accept.images);

  // Auto-resize
  useEffect(() => {
    const ta = textAreaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(200, ta.scrollHeight) + "px";
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

  // Previews are the browser's own copies of the images, freed when the composer goes
  const attachedRef = useRef(attached);
  useEffect(() => {
    attachedRef.current = attached;
  }, [attached]);
  useEffect(
    () => () => {
      clearTimeout(noteTimer.current);
      for (const a of attachedRef.current) if (a.preview) URL.revokeObjectURL(a.preview);
    },
    []
  );

  function showNote(text: string) {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), NOTE_MS);
  }

  /** Adds the files the chat takes; says why the first other one cannot be added. */
  function addFiles(files: File[]) {
    if (!accept || !files.length) return;
    const room = MAX_FILES_PER_MESSAGE - attached.length;
    const problems: string[] = [];
    const added: Attached[] = [];
    for (const file of files) {
      const problem = fileProblem(accept, file);
      if (problem) problems.push(problem);
      else if (added.length < room) {
        added.push({ file, preview: fileKind(file.name) === "image" ? URL.createObjectURL(file) : null });
      } else problems.push(`At most ${MAX_FILES_PER_MESSAGE} files per message`);
    }
    if (added.length) setAttached((prev) => [...prev, ...added]);
    if (problems.length) showNote(problems[0]);
  }

  function removeFile(index: number) {
    const gone = attached[index];
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    setAttached((prev) => prev.filter((_, i) => i !== index));
  }

  function submit() {
    const text = input.trim();
    if ((!text && !attached.length) || isStreaming) return;
    const files = attached.map((a) => a.file);
    setInput("");
    // The sent message shows its files from copies of its own
    for (const a of attached) if (a.preview) URL.revokeObjectURL(a.preview);
    setAttached([]);
    setNote(null);
    // Close the on-screen keyboard now, so the viewport does not resize while the reply streams in
    textAreaRef.current?.blur();
    onSend(text, files);
  }

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
          {attached.map((a, i) => (
            <span key={`${a.file.name}-${i}`} className={styles.attachedFile} title={a.file.name}>
              {a.preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- the browser's copy of the user's image
                <img src={a.preview} alt="" className={styles.attachedThumb} />
              ) : (
                <TypeIcon name={a.file.name} className={styles.attachedIcon} />
              )}
              <span className={styles.attachedName}>{a.file.name}</span>
              <span className={styles.attachedSize}>{formatSize(a.file.size)}</span>
              <button
                type="button"
                className={styles.attachedRemove}
                aria-label={`Remove ${a.file.name}`}
                onClick={() => removeFile(i)}
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
      ) : (
        <button
          type="submit"
          aria-label="Send"
          disabled={!input.trim() && !attached.length}
          className={styles.iconButton}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 12L20 4L12 20L11 13L4 12Z" transform="translate(-0.5 0)" />
          </svg>
        </button>
      )}
    </form>
  );
}
