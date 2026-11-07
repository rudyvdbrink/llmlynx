import styles from "../Chat.module.css";
import { CodeFileIcon, DownloadIcon, FileIcon, ImageIcon, SheetIcon, SlidesIcon } from "@/components/icons";
import { extensionOf, fileKind, formatSize, isInlineImage, typeLabel, type FileCard } from "@/lib/files";

/** An icon for the kind of file: a sheet, slides, an image, code, or a page of text. */
export function TypeIcon({ name, className }: { name: string; className?: string }) {
  const ext = extensionOf(name);
  if (ext === "xlsx" || ext === "xls" || ext === "csv" || ext === "tsv") return <SheetIcon className={className} />;
  if (ext === "pptx") return <SlidesIcon className={className} />;
  if (fileKind(name) === "image") return <ImageIcon className={className} />;
  if (fileKind(name) === "text" && !["txt", "md", "markdown", "log"].includes(ext)) return <CodeFileIcon className={className} />;
  return <FileIcon className={className} />;
}

/**
 * The files of a message: those the user attached, or those an agent made.
 * A click downloads the file; images show in the chat, and open full size in
 * the browser. Files of a message that is still being sent come from the
 * browser's own copy (`url`).
 */
export default function FileCards({ files }: { files: FileCard[] }) {
  return (
    <div className={styles.fileCards}>
      {files.map((file) => {
        const src = file.url ?? `/api/attachments/${file.id}`;
        const download = file.url ?? `/api/attachments/${file.id}?download=1`;
        const meta = `${typeLabel(file.name)} · ${formatSize(file.size)}`;
        if (isInlineImage(file.mimeType) || (file.url && fileKind(file.name) === "image")) {
          return (
            <figure key={file.id} className={styles.fileImage}>
              <a href={src} target="_blank" rel="noopener" aria-label={`Open ${file.name}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset */}
                <img src={src} alt={file.name} loading="lazy" />
              </a>
              <a className={styles.fileImageCaption} href={download} download={file.name} title={`Download ${file.name}`}>
                <span className={styles.fileName}>{file.name}</span>
                <DownloadIcon size={14} className={styles.fileDownload} />
              </a>
            </figure>
          );
        }
        return (
          <a key={file.id} className={styles.fileCard} href={download} download={file.name} title={`Download ${file.name}`}>
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
