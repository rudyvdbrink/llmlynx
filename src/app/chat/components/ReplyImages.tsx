"use client";

// The images a reply shows in its text (see lib/inlineImages.ts): what the
// markdown of a reply needs to show them, and the parts they are made of.

import { createContext, useContext, type ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import styles from "../Chat.module.css";
import ImageLink from "./ImageLink";
import { baseName, type FileCard } from "@/lib/files";
import { isWebRef } from "@/lib/inlineImages";

/**
 * What the text of a reply needs to show its images: the image file an
 * image's source names (or null), how to show a file in the viewer, and
 * whether the reply still streams in, when a name may not match a file yet.
 */
export type ReplyImages = {
  resolve: (src: string) => FileCard | null;
  open: (fileId: string) => void;
  live: boolean;
};

// Outside a reply, such as a markdown file in the sandbox panel, no name matches a file
const NONE: ReplyImages = { resolve: () => null, open: () => {}, live: false };

export const ReplyImagesContext = createContext<ReplyImages>(NONE);

export const imageSrc = (file: FileCard) => `/api/attachments/${file.id}`;

/** What shows in the place of an image whose name matches no file: its alt text, as for an image from the web. */
export const imageLabel = (alt: string) => (alt ? `Image: ${alt}` : "Image");

/**
 * An image file of the sandbox. A plain click shows it in the viewer; with a
 * modifier key or the middle button, it opens in a tab.
 */
export function ImageButton({ file, alt, className }: { file: FileCard; alt: string; className?: string }) {
  const { open } = useContext(ReplyImagesContext);
  return (
    <a
      className={className}
      href={imageSrc(file)}
      target="_blank"
      rel="noopener"
      aria-label={`Show ${alt || baseName(file.name)} big`}
      onClick={(e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        open(file.id);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset */}
      <img src={imageSrc(file)} alt={alt} loading="lazy" draggable={false} />
    </a>
  );
}

/** In the place of an image while the reply streams in and its name matches no file yet: its alt text, pulsing. */
export function ImagePlaceholder({ alt, className }: { alt: string; className?: string }) {
  return (
    <span className={`${styles.imagePlaceholder} ${className ?? ""}`} role="img" aria-label={alt || "Image"}>
      <span className={styles.imagePlaceholderText}>{alt}</span>
    </span>
  );
}

/**
 * An image in a line of text or in a table (images that stand alone are
 * figures, see ImageFigure.tsx): an image file of the sandbox shows small;
 * an image from the web is a link; a name that matches no file is its label.
 */
export function InlineImage(props: ComponentProps<"img"> & ExtraProps) {
  const { resolve, live } = useContext(ReplyImagesContext);
  const src = typeof props.src === "string" ? props.src : "";
  const alt = props.alt?.trim() ?? "";
  if (!src || isWebRef(src)) return <ImageLink {...props} />;
  const file = resolve(src);
  if (file) return <ImageButton file={file} alt={alt} className={styles.inlineImage} />;
  if (live) return <ImagePlaceholder alt={alt} className={styles.inlinePlaceholder} />;
  return <>{imageLabel(alt)}</>;
}
