"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import styles from "../Chat.module.css";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "@/components/icons";

export type ViewerImage = { src: string; name: string };

// How far a finger must move sideways to go to the next or previous image
const SWIPE_PX = 50;

/**
 * The images of a message shown big, one at a time, over the page, which
 * darkens behind them. A click beside the image, the close button or Escape
 * closes it. With more than one image, the arrows beside it, the arrow keys
 * and a swipe go to the previous or next one, round at the ends. `onClose`
 * runs once the dialog has closed, after which the browser gives the focus
 * back to the image in the chat.
 */
export default function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: ViewerImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const image = images[index];
  const many = images.length > 1;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.focus();
  }, []);

  const close = () => ref.current?.close();
  const go = (step: number) => onIndex((index + step + images.length) % images.length);

  return createPortal(
    <dialog
      ref={ref}
      className={styles.viewer}
      aria-label={image.name}
      tabIndex={-1}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        if (!many || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        go(e.key === "ArrowLeft" ? -1 : 1);
      }}
      onTouchStart={(e) => {
        touch.current = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      }}
      onTouchEnd={(e) => {
        const start = touch.current;
        touch.current = null;
        // Not while pinch-zoomed in, where a finger moves the view
        if (!start || !many || (window.visualViewport?.scale ?? 1) > 1.01) return;
        const dx = e.changedTouches[0].clientX - start.x;
        const dy = e.changedTouches[0].clientY - start.y;
        if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset */}
      <img className={styles.viewerImage} src={image.src} alt={image.name} draggable={false} />
      {many && (
        <>
          <button type="button" className={`${styles.viewerButton} ${styles.viewerPrev}`} aria-label="Previous image" onClick={() => go(-1)}>
            <ChevronLeftIcon size={22} />
          </button>
          <button type="button" className={`${styles.viewerButton} ${styles.viewerNext}`} aria-label="Next image" onClick={() => go(1)}>
            <ChevronRightIcon size={22} />
          </button>
        </>
      )}
      <button type="button" className={`${styles.viewerButton} ${styles.viewerClose}`} aria-label="Close" onClick={close}>
        <XIcon size={20} />
      </button>
    </dialog>,
    document.body
  );
}
