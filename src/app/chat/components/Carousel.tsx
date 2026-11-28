"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import styles from "../Chat.module.css";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import type { FileCard } from "@/lib/files";
import { ImageButton, ImagePlaceholder, imageSrc } from "./ReplyImages";

/** An image of a carousel: its file, or null while the reply streams in and its name matches no file yet. */
export type CarouselItem = { alt: string; file: FileCard | null };

const smooth = (): ScrollBehavior =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

/**
 * Images that stand alone one after the other in a reply's text, one at a
 * time in the chat. Nothing lies over the image. It scrolls sideways and
 * stops at each image, so a swipe, the trackpad and the arrow keys (with the
 * focus anywhere in it, a clicked thumbnail too) go through them. Below it: the image's alt text as its caption, the previous
 * and next buttons with a counter between them, and a strip with a thumbnail
 * of every image, which shows at once that there are more and goes to the
 * one clicked. A click on the image shows it big, in the viewer of the reply.
 */
export default function Carousel({ items }: { items: CarouselItem[] }) {
  const track = useRef<HTMLDivElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);
  const count = items.length;
  const current = Math.min(index, count - 1);
  const caption = items[current]?.alt ?? "";

  const show = (to: number) => {
    const el = track.current;
    if (!el) return undefined;
    const i = Math.max(0, Math.min(count - 1, to));
    el.scrollTo({ left: i * el.clientWidth, behavior: smooth() });
    return i;
  };

  // The arrow keys go through the images wherever the focus is in the carousel. On a
  // thumbnail, the focus goes along to the next one, and counts from it, so quick
  // presses do not wait for the image to scroll into view.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    const thumbs = strip.current ? [...strip.current.children] : [];
    const thumb = thumbs.indexOf(e.target as Element);
    const to = show((thumb >= 0 ? thumb : current) + (e.key === "ArrowLeft" ? -1 : 1));
    if (thumb >= 0 && to !== undefined) (thumbs[to] as HTMLElement | undefined)?.focus({ preventScroll: true });
  };

  // The thumbnail of the image in view stays in view in its strip, which scrolls on its own
  useEffect(() => {
    const el = strip.current;
    const thumb = el?.children[current] as HTMLElement | undefined;
    if (!el || !thumb) return;
    const start = thumb.offsetLeft;
    const end = start + thumb.offsetWidth;
    if (start < el.scrollLeft) el.scrollTo({ left: start, behavior: smooth() });
    else if (end > el.scrollLeft + el.clientWidth) el.scrollTo({ left: end - el.clientWidth, behavior: smooth() });
  }, [current]);

  return (
    <figure className={styles.carousel} role="region" aria-roledescription="carousel" aria-label="Images" onKeyDown={onKeyDown}>
      <div
        ref={track}
        className={styles.carouselTrack}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.clientWidth) setIndex(Math.round(el.scrollLeft / el.clientWidth));
        }}
      >
        {items.map((item, i) => (
          <div key={i} className={styles.carouselSlide} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${count}`}>
            {item.file ? (
              <ImageButton file={item.file} alt={item.alt} className={styles.carouselImage} />
            ) : (
              <ImagePlaceholder alt={item.alt} className={styles.carouselPlaceholder} />
            )}
          </div>
        ))}
      </div>
      <div className={styles.carouselBar}>
        <figcaption className={styles.carouselCaption} title={caption || undefined}>
          {caption}
        </figcaption>
        <div className={styles.carouselNav}>
          <button type="button" className={styles.carouselButton} aria-label="Previous image" disabled={current <= 0} onClick={() => show(current - 1)}>
            <ChevronLeftIcon size={16} />
          </button>
          <span className={styles.carouselCount} aria-live="polite">
            {current + 1} / {count}
          </span>
          <button type="button" className={styles.carouselButton} aria-label="Next image" disabled={current >= count - 1} onClick={() => show(current + 1)}>
            <ChevronRightIcon size={16} />
          </button>
        </div>
      </div>
      <div ref={strip} className={styles.carouselThumbs} role="group" aria-label="All images">
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            className={`${styles.carouselThumb} ${i === current ? styles.carouselThumbCurrent : ""}`}
            aria-label={`Image ${i + 1}${item.alt ? `: ${item.alt}` : ""}`}
            aria-current={i === current}
            onClick={(e) => {
              e.currentTarget.focus({ preventScroll: true });
              show(i);
            }}
          >
            {item.file ? (
              // eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset
              <img src={imageSrc(item.file)} alt="" loading="lazy" draggable={false} />
            ) : (
              <span className={`${styles.imagePlaceholder} ${styles.carouselThumbEmpty}`} />
            )}
          </button>
        ))}
      </div>
    </figure>
  );
}
