"use client";

import { useState } from "react";
import styles from "../Chat.module.css";
import ImageViewer, { type ViewerImage } from "./ImageViewer";
import { CodeFileIcon, DownloadIcon, ExternalLinkIcon, FileIcon, ImageIcon, SheetIcon, SlidesIcon } from "@/components/icons";
import { baseName, extensionOf, fileKind, formatSize, isHtml, isInlineImage, isSvg, typeLabel, type FileCard } from "@/lib/files";

/** An icon for the kind of file: a sheet, slides, an image, code, or a page of text. */
export function TypeIcon({ name, className }: { name: string; className?: string }) {
  const ext = extensionOf(name);
  if (ext === "xlsx" || ext === "xls" || ext === "csv" || ext === "tsv") return <SheetIcon className={className} />;
  if (ext === "pptx") return <SlidesIcon className={className} />;
  if (fileKind(name) === "image" || ext === "svg") return <ImageIcon className={className} />;
  if (fileKind(name) === "text" && !["txt", "md", "markdown", "log"].includes(ext)) return <CodeFileIcon className={className} />;
  return <FileIcon className={className} />;
}

/** Images and SVG, which show in the chat; and, while a message is being sent, any image the browser has. */
const isImage = (file: FileCard) =>
  isInlineImage(file.mimeType) || isSvg(file.mimeType) || (!!file.url && fileKind(file.name) === "image");

/** Text and code, which show in the sandbox panel. */
const showsInSandbox = (file: FileCard) => !file.url && fileKind(file.name) === "text";

// A file card asks the chat to show its file in the sandbox panel (see ChatClientPage.tsx)
export const SHOW_FILE_EVENT = "llmlynx:show-file";

/** Asks the chat to show the file version `id` in the sandbox panel; false when nothing showed it. */
function showInSandbox(id: string): boolean {
  return !window.dispatchEvent(new CustomEvent(SHOW_FILE_EVENT, { detail: id, cancelable: true }));
}

/**
 * An HTML file in a sandboxed frame: its scripts run, in an origin of its own,
 * and it can load or send nothing (see /api/attachments/:id/frame). The page
 * at /view/:id shows it full size, in the same frame.
 */
export function HtmlFrame({ id, title, className }: { id: string; title: string; className?: string }) {
  return (
    <iframe
      className={className}
      src={`/api/attachments/${id}/frame`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      title={title}
    />
  );
}

/**
 * The files of a message: those the user attached, or those an agent made or
 * shared. Images and SVG show in the chat, and a click shows them big in an
 * ImageViewer, which goes through the message's images in turn; HTML shows in a sandboxed frame, with a button that opens it full size;
 * text and code are cards that show the file in the sandbox panel, with a
 * button that downloads it (they download where the chat has no such panel);
 * every other file is a card that downloads it. Files of a message that is
 * still being sent come from the browser's own copy (`url`).
 */
export default function FileCards({ files }: { files: FileCard[] }) {
  // The images, in order, and which one the viewer shows
  const images: (ViewerImage & { id: string })[] = files.filter(isImage).map((file) => ({
    id: file.id,
    src: file.url ?? `/api/attachments/${file.id}`,
    name: baseName(file.name),
  }));
  const [viewing, setViewing] = useState<number | null>(null);

  return (
    <div className={styles.fileCards}>
      {viewing !== null && images[viewing] && (
        <ImageViewer images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      )}
      {files.map((file) => {
        const src = file.url ?? `/api/attachments/${file.id}`;
        const download = file.url ?? `/api/attachments/${file.id}?download=1`;
        const name = baseName(file.name);
        const meta = `${typeLabel(file.name)} · ${formatSize(file.size)}`;
        if (!file.url && isHtml(file.mimeType)) {
          return (
            <figure key={file.id} className={`${styles.fileImage} ${styles.fileFrame}`}>
              <HtmlFrame id={file.id} title={file.name} className={styles.fileFrameView} />
              <div className={styles.fileImageCaption}>
                <span className={styles.fileName} title={file.name}>
                  {name}
                </span>
                <span className={styles.fileActions}>
                  <a href={`/view/${file.id}`} target="_blank" rel="noopener" title={`Open ${name} full size`} aria-label={`Open ${name} full size`}>
                    <ExternalLinkIcon size={14} className={styles.fileDownload} />
                  </a>
                  <a href={download} download={name} title={`Download ${name}`} aria-label={`Download ${name}`}>
                    <DownloadIcon size={14} className={styles.fileDownload} />
                  </a>
                </span>
              </div>
            </figure>
          );
        }
        if (isImage(file)) {
          return (
            <figure key={file.id} className={styles.fileImage}>
              {/* A plain click shows it in the viewer; with a modifier key or the middle button it opens in a tab */}
              <a
                href={src}
                target="_blank"
                rel="noopener"
                aria-label={`Open ${name}`}
                onClick={(e) => {
                  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  setViewing(images.findIndex((image) => image.id === file.id));
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset */}
                <img src={src} alt={name} loading="lazy" />
              </a>
              <a className={styles.fileImageCaption} href={download} download={name} title={`Download ${name}`}>
                <span className={styles.fileName}>{name}</span>
                <DownloadIcon size={14} className={styles.fileDownload} />
              </a>
            </figure>
          );
        }
        if (showsInSandbox(file)) {
          return (
            <div key={file.id} className={`${styles.fileCard} ${styles.fileCardSplit}`}>
              <a
                className={styles.fileOpen}
                href={download}
                download={name}
                title={`Show ${file.name} in the sandbox`}
                onClick={(e) => {
                  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                  if (showInSandbox(file.id)) e.preventDefault();
                }}
              >
                <TypeIcon name={file.name} className={styles.fileTypeIcon} />
                <span className={styles.fileText}>
                  <span className={styles.fileName}>{file.name}</span>
                  <span className={styles.fileMeta}>{meta}</span>
                </span>
              </a>
              <a className={styles.fileGet} href={download} download={name} title={`Download ${file.name}`} aria-label={`Download ${file.name}`}>
                <DownloadIcon size={16} className={styles.fileDownload} />
              </a>
            </div>
          );
        }
        return (
          <a key={file.id} className={styles.fileCard} href={download} download={name} title={`Download ${file.name}`}>
            <TypeIcon name={file.name} className={styles.fileTypeIcon} />
            <span className={styles.fileText}>
              <span className={styles.fileName}>{file.name}</span>
              <span className={styles.fileMeta}>{meta}</span>
            </span>
            <DownloadIcon size={16} className={styles.fileDownload} />
          </a>
        );
      })}
    </div>
  );
}
