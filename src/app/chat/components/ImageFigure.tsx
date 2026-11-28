"use client";

import { useContext, type ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import styles from "../Chat.module.css";
import Carousel, { type CarouselItem } from "./Carousel";
import { ImageButton, ImagePlaceholder, imageLabel, ReplyImagesContext } from "./ReplyImages";

/**
 * Images that stand alone in a reply's text, as imageGroups.ts groups them:
 * one image with its alt text as its caption, or a carousel of two or more.
 * While the reply streams in, an image whose name matches no file yet holds
 * its place; once it is over, such an image is left out, and its label
 * shows below the others.
 */
export default function ImageFigure({ node }: ComponentProps<"figure"> & ExtraProps) {
  const { resolve, live } = useContext(ReplyImagesContext);
  const items: CarouselItem[] = (node?.children ?? []).flatMap((child) => {
    if (child.type !== "element" || child.tagName !== "img") return [];
    const { src, alt } = child.properties;
    return [{ alt: typeof alt === "string" ? alt.trim() : "", file: typeof src === "string" ? resolve(src) : null }];
  });
  const shown = live ? items : items.filter((item) => item.file);
  const missing = live ? [] : items.filter((item) => !item.file);
  const labels = missing.length ? <p>{missing.map((item) => imageLabel(item.alt)).join(" · ")}</p> : null;

  if (shown.length > 1) {
    return (
      <>
        <Carousel items={shown} />
        {labels}
      </>
    );
  }
  const [item] = shown;
  if (!item) return labels;
  return (
    <>
      <figure className={styles.imageFigure}>
        {item.file ? (
          <ImageButton file={item.file} alt={item.alt} className={styles.figureImage} />
        ) : (
          <ImagePlaceholder alt={item.alt} className={styles.figurePlaceholder} />
        )}
        {item.alt && <figcaption className={styles.imageCaption}>{item.alt}</figcaption>}
      </figure>
      {labels}
    </>
  );
}
