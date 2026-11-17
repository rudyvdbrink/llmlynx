"use client";

import { useEffect, type RefObject } from "react";
import { composerDrop } from "./useAutoScroll";

// How much of the distance left a glide keeps per 60 Hz frame (about 200 ms in all)
const GLIDE_KEEP = 0.8;

/**
 * On wide screens, where the composer can drop (see Chat.module.css), lets it
 * glide when the messages above it change height and move it, as when a reply
 * pushes it down, instead of jumping there. Scrolling moves it at once.
 * `dockRef` is the composer's dock, right after the message list.
 */
export function useComposerGlide(dockRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dock = dockRef.current;
    const messages = dock?.previousElementSibling;
    if (!dock || !messages) return;
    // How far the dock is drawn from where the page puts it
    let offset = 0;
    // Where the page puts it (its distance to the bottom of the viewport)
    const place = () => window.innerHeight - dock.getBoundingClientRect().bottom + offset;
    let gap = place();
    // The message list's height when `gap` was taken
    const listHeight = () => messages.getBoundingClientRect().height;
    let height = listHeight();
    let frame = 0;
    let last = 0;

    function draw() {
      dock!.style.transform = offset ? `translateY(${offset}px)` : "";
    }
    function glide(now: number) {
      offset *= GLIDE_KEEP ** ((last ? now - last : 16.7) / 16.7);
      if (Math.abs(offset) < 0.5) offset = 0;
      last = now;
      draw();
      frame = offset ? requestAnimationFrame(glide) : 0;
    }
    // After layout and before paint: the dock is drawn where it was, and glides from there
    const observer = new ResizeObserver(() => {
      const next = place();
      if (composerDrop(dock)) offset += next - gap;
      gap = next;
      height = listHeight();
      draw();
      if (offset && !frame) {
        last = 0;
        frame = requestAnimationFrame(glide);
      }
    });
    // A scroll moves it at once. Unless the list changed since: then the page
    // may not have followed it yet, and the observer sees both together.
    function sync() {
      if (listHeight() === height) gap = place();
    }
    observer.observe(messages);
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      dock.style.transform = "";
    };
  }, [dockRef]);
}
