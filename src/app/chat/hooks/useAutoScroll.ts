"use client";

import { useLayoutEffect, useRef } from "react";
import { scrollRoom } from "@/lib/viewport";

// Keys that scroll the page up
const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

// True when the user's scroll at `target` is taken by an inner scroll area (such
// as the sidebar's conversation list) instead of the page.
function innerScrollsUp(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (el.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return true;
  }
  return false;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

// On wide screens the composer drops below its resting place while the page is
// not at its end (--composer-drop in Chat.module.css); `el` is in the chat area
export function composerDrop(el: Element | null): number {
  return el ? parseFloat(getComputedStyle(el).getPropertyValue("--composer-drop")) || 0 : 0;
}

// Where the page shows the end of the messages just above the composer: short
// of the end of the page while the composer can drop
function messagesEnd(el: Element | null): number {
  const drop = composerDrop(el);
  return drop ? scrollRoom() - drop : document.documentElement.scrollHeight;
}

/**
 * Keeps the end of the messages in view while a reply streams in, until the
 * user scrolls up. Each new reply follows again. When the messages change
 * outside a reply (a conversation is opened), the page scrolls there once.
 * Returns a ref for an element at the end of the message list.
 */
export function useAutoScroll(messages: unknown, isStreaming: boolean) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const wasStreaming = useRef(isStreaming);

  useLayoutEffect(() => {
    // The render that ends a reply still belongs to it
    const replying = isStreaming || wasStreaming.current;
    wasStreaming.current = isStreaming;
    if (!replying) window.scrollTo({ top: messagesEnd(endRef.current), behavior: "smooth" });
  }, [messages, isStreaming]);

  useLayoutEffect(() => {
    if (!isStreaming) return;
    let following = true;
    // Where the page was last pinned, and how far it could scroll then
    let pinnedTop = -Infinity;
    let pinnedRoom = 0;
    // With a mouse, the page moving up also counts, which catches scrollbar drags.
    // Not on touch devices: their keyboard and toolbars move the page by themselves.
    const checkPosition = window.matchMedia("(pointer: fine)").matches;

    // A page further down than the end of the messages, toward where the
    // composer rests, stays there until the reply has pushed the composer down.
    // Set when the page is first pinned, and when the user scrolls down.
    let further = false;

    function pin() {
      const end = messagesEnd(endRef.current);
      if (window.scrollY > pinnedTop + 2 || end >= window.scrollY) further = window.scrollY > end;
      if (!further) window.scrollTo(0, end);
      pinnedTop = window.scrollY;
      pinnedRoom = scrollRoom();
    }
    function stop() {
      following = false;
    }

    // Pin once per frame, before paint, so new text never shows below the composer.
    // If the page moved up although it can still scroll as far as before, the user
    // scrolled. When the content or the viewport gets shorter, the browser moves
    // the page itself; that is not counted.
    let frame = 0;
    function tick() {
      if (!following) return;
      if (checkPosition && window.scrollY < pinnedTop - 2 && scrollRoom() >= pinnedRoom) return stop();
      pin();
      frame = requestAnimationFrame(tick);
    }

    // Input that scrolls up stops it at once, before a pin can undo the scroll
    function onWheel(e: WheelEvent) {
      if (e.deltaY < 0 && !innerScrollsUp(e.target)) stop();
    }
    // A finger moving down the screen scrolls up. Measured from its highest point,
    // so a swipe that turns around counts too.
    let touchTop = 0;
    function onTouchStart(e: TouchEvent) {
      touchTop = e.touches[0].clientY;
    }
    function onTouchMove(e: TouchEvent) {
      const y = e.touches[0].clientY;
      if (y > touchTop + 4 && !innerScrollsUp(e.target)) stop();
      touchTop = Math.min(touchTop, y);
    }
    function onKeyDown(e: KeyboardEvent) {
      if ((SCROLL_UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) && !isEditable(e.target)) stop();
    }
    // A press on the page scrollbar, or the middle button (autoscroll)
    function onPointerDown(e: PointerEvent) {
      if (e.button === 1 || e.clientX >= document.documentElement.clientWidth) stop();
    }

    // The first pin waits for the next frame. Sending resizes the composer, which
    // briefly collapses it to measure, and that can move the page in some browsers.
    frame = requestAnimationFrame(tick);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isStreaming]);

  return endRef;
}
