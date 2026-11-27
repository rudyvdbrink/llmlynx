"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "../Chat.module.css";
import { ChevronRightIcon } from "@/components/icons";
import MarkdownMessage from "./MarkdownMessage";
import CopyButton from "./CopyButton";
import Thinking, { useShowToolCall } from "./Thinking";
import FileCards from "./FileCards";
import ImageViewer, { type ViewerImage } from "./ImageViewer";
import { imageSrc, ReplyImagesContext, type ReplyImages } from "./ReplyImages";
import type { FileCard } from "@/lib/files";
import { replyImages, resolveImage } from "@/lib/inlineImages";
import type { DisplayMessage, ReplyStatus, TraceItem } from "@/lib/types";

const errorNote = (error: string) => `*(Error: ${error})*`;

const NO_ITEMS: TraceItem[] = [];
const NO_FILES: FileCard[] = [];

// A part of a reply: text the model wrote to the user, or what it did between two such texts
type Part = { kind: "text"; text: string } | { kind: "thinking"; items: TraceItem[] };

/** The reply's trace in parts, in order, with why it failed as text at its end. */
function partsOf(trace: TraceItem[], error?: string): Part[] {
  const parts: Part[] = [];
  for (const item of trace) {
    const last = parts[parts.length - 1];
    if (item.kind === "text") parts.push({ kind: "text", text: item.text });
    else if (last?.kind === "thinking") last.items.push(item);
    else parts.push({ kind: "thinking", items: [item] });
  }
  if (error) {
    const last = parts[parts.length - 1];
    if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: `${last.text}\n\n${errorNote(error)}` };
    else parts.push({ kind: "text", text: errorNote(error) });
  }
  return parts;
}

/**
 * The trace items of the parts before the reply's last text, when there is
 * more than one such part to fold away. Otherwise (also while the reply has no
 * text at its end) null.
 */
function chainOf(parts: Part[]): TraceItem[] | null {
  if (parts.length < 3 || parts[parts.length - 1].kind !== "text") return null;
  return parts.flatMap((part) => (part.kind === "thinking" ? part.items : []));
}

/**
 * The colour of a thinking part's dot: amber when a tool call in it failed or
 * the security checks withheld its result, so the user can find what went
 * wrong; blue when it used tools; grey when it only reasoned.
 */
function dotOf(items: TraceItem[]): string {
  const steps = items.flatMap((item) => (item.kind === "tool" ? [item.step] : []));
  if (steps.some((step) => step.state === "error" || !!step.security)) return styles.dotIssue;
  return steps.length ? styles.dotTools : styles.dotThinking;
}

/**
 * A reply, as a timeline of its parts: each text the model wrote to the user,
 * and what it did between them (its reasoning and tool calls), which folds
 * away behind a "Show thinking" toggle once the next text starts. A dot marks
 * each part, and a line joins them; a reply that is only text has neither.
 * While the reply comes in (`live`), its
 * last part shows what the model is doing now, with the status icon in the
 * place of its dot; when that is text, its dot pulses. Once it is over, a
 * chain of parts before its last text (see chainOf) folds away behind a
 * "Show chain of thought" toggle, with a dot coloured by all that the chain did.
 * Below the parts: the files the agent made, and the copy button once the
 * reply is over.
 *
 * Its text shows the image files it names (see lib/inlineImages.ts), which
 * are then left out of the files below it. A click on any of its images shows
 * it big, in one viewer that goes through all of them: those of the text in
 * order, then those below it.
 */
function Reply({ msg, live, status }: { msg: DisplayMessage; live: boolean; status: ReplyStatus | null }) {
  const parts = useMemo(() => partsOf(msg.trace ?? [], msg.error), [msg.trace, msg.error]);

  const images = msg.imageFiles ?? NO_FILES;
  const { viewer, cards } = useMemo(() => replyImages([msg.content], images, msg.files ?? NO_FILES), [msg.content, images, msg.files]);
  const viewerImages: (ViewerImage & { id: string })[] = useMemo(
    () => viewer.map(({ file, name }) => ({ id: file.id, src: imageSrc(file), name })),
    [viewer]
  );
  const [viewing, setViewing] = useState<number | null>(null);
  // Read when an image is clicked, so that the text's images do not render anew with each part of the text
  const viewerRef = useRef(viewerImages);
  useEffect(() => {
    viewerRef.current = viewerImages;
  }, [viewerImages]);
  const openImage = useCallback((fileId: string) => {
    const i = viewerRef.current.findIndex((image) => image.id === fileId);
    if (i >= 0) setViewing(i);
  }, []);
  const imagesOfText: ReplyImages = useMemo(
    () => ({ resolve: (src) => resolveImage(src, images), open: openImage, live }),
    [images, openImage, live]
  );
  // Until its text starts, and between its texts, the reply shows what the model is doing
  const waiting = live && parts[parts.length - 1]?.kind !== "text";
  const shown: Part[] = waiting && !parts.length ? [{ kind: "thinking", items: [] }] : parts;

  const chain = useMemo(() => (live ? null : chainOf(parts)), [live, parts]);
  const [chainOpen, setChainOpen] = useState(false);
  // The sandbox panel's link to a run in the chain opens it
  const openChain = useCallback(() => setChainOpen(true), []);
  useShowToolCall(chain ?? NO_ITEMS, openChain);

  return (
    <ReplyImagesContext.Provider value={imagesOfText}>
      <div className={`${styles.messageRow} ${styles.bot}`}>
        {viewing !== null && viewerImages[viewing] && (
          <ImageViewer images={viewerImages} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
        )}
        <div className={styles.timeline}>
          {chain && (
            <div key="chain" className={styles.part}>
              <span className={`${styles.dot} ${dotOf(chain)}`} />
              <div className={styles.thinking}>
                <button
                  type="button"
                  className={styles.thinkingToggle}
                  aria-expanded={chainOpen}
                  onClick={() => setChainOpen((o) => !o)}
                >
                  <ChevronRightIcon className={styles.thinkingChevron} />
                  {chainOpen ? "Hide chain of thought" : "Show chain of thought"}
                </button>
              </div>
            </div>
          )}
          {shown.map((part, i) => {
            const last = i === shown.length - 1;
            // The parts in the chain fold away, each in its place, so that none of them renders anew
            const chained = chain && !last ? `${styles.chained} ${chainOpen ? "" : styles.folded}` : "";
            if (part.kind === "text") {
              return (
                <div key={`text${i}`} className={`${styles.part} ${styles.textPart} ${chained}`}>
                  {shown.length > 1 && <span className={`${styles.dot} ${styles.dotText} ${live && last ? styles.dotLive : ""}`} />}
                  <div className={styles.bubble}>
                    <MarkdownMessage content={part.text} />
                  </div>
                </div>
              );
            }
            const current = waiting && last;
            return (
              <div key={`thinking${i}`} className={`${styles.part} ${current ? styles.livePart : ""} ${chained}`}>
                {!current && <span className={`${styles.dot} ${dotOf(part.items)}`} />}
                <Thinking trace={part.items} status={current ? status : "done"} />
              </div>
            );
          })}
        </div>
        {(!waiting || !!msg.content) && (
          <div className={`${styles.bubble} ${styles.replyEnd}`}>
            {!!cards.length && <FileCards files={cards} onOpenImage={openImage} />}
            {!live && <CopyButton className={styles.messageCopyBtn} label="Copy response" getText={() => msg.content} />}
          </div>
        )}
      </div>
    </ReplyImagesContext.Provider>
  );
}

export default memo(Reply);
