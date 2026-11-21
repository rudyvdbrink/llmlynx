"use client";

import { useLayoutEffect, useRef } from "react";
import { scrollRoom } from "@/lib/viewport";

// Keys that scroll the page up
const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

// Whether a scroll up where an input happened (`path`: the element and its
// ancestors) moves the page, as browsers pass it on: not while the page cannot
// scroll up (at its top, or held in place under the sandbox panel on phones and
// under the image viewer), and not when an area it is in scrolls up itself, or
// keeps scrolls to itself (overscroll-behavior, as the sandbox panel and the
// sidebar do).
function pageScrollsUp(path: EventTarget[]): boolean {
  if (window.scrollY <= 0 || getComputedStyle(document.documentElement).overflowY === "hidden") return false;
  for (const el of path) {
    if (!(el instanceof Element) || el === document.body) break;
    const style = getComputedStyle(el);
    if (!/auto|scroll|hidden/.test(style.overflowY)) continue;
    if (style.overscrollBehaviorY !== "auto" || (el.scrollTop > 0 && style.overflowY !== "hidden")) return false;
  }
  return true;
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
 * user scrolls up, and again once they scroll back down to it. Each new reply
 * follows again. When the messages change
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
    // Where the page was at the last pin or scroll event
    let lastTop = window.scrollY;
    // With a mouse, the page moving up also counts, which catches scrollbar drags.
    // Not on touch devices: their keyboard and toolbars move the page by themselves.
    const finePointer = window.matchMedia("(pointer: fine)").matches;

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
      lastTop = pinnedTop;
    }
    function stop() {
      following = false;
    }

    // A scroll down to the end of the messages follows again. Scrolls are measured
    // from the last pin too, so the scroll event of a pin just before a stop does
    // not count as one.
    function onScroll() {
      const top = window.scrollY;
      const down = top > lastTop;
      lastTop = top;
      if (following || !down || top < Math.min(messagesEnd(endRef.current), scrollRoom()) - 2) return;
      following = true;
      pinnedTop = -Infinity;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    }

    // Pin once per frame, before paint, so new text never shows below the composer.
    // If the page moved up although it can still scroll as far as before, the user
    // scrolled. When the content or the viewport gets shorter, the browser moves
    // the page itself; that is not counted.
    let frame = 0;
    function tick() {
      if (!following) return;
      if (finePointer && window.scrollY < pinnedTop - 2 && scrollRoom() >= pinnedRoom) return stop();
      pin();
      frame = requestAnimationFrame(tick);
    }

    // Input that scrolls the page up stops it at once, before a pin can undo the scroll
    function onWheel(e: WheelEvent) {
      if (e.deltaY < 0 && pageScrollsUp(e.composedPath())) stop();
    }
    // A finger moving down the screen scrolls up; one moving more sideways than
    // down swipes something sideways (code, a table), and two fingers zoom.
    // Measured from its highest point, so a swipe that turns around counts too.
    // A finger's moves and its end go to the element it started on, also once
    // the reply has redrawn it (streaming text, the status line). They no longer
    // reach the window then, so they are listened for on that element.
    let touchTop = { x: 0, y: 0 };
    let touchPath: EventTarget[] = [];
    const touched = new Set<HTMLElement>();
    function onTouchStart(e: TouchEvent) {
      touchTop = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      touchPath = e.composedPath();
      const target = e.target as HTMLElement | null;
      if (!target || touched.has(target)) return;
      touched.add(target);
      target.addEventListener("touchmove", onTouchMove, { passive: true });
      target.addEventListener("touchend", onTouchEnd);
      target.addEventListener("touchcancel", onTouchEnd);
    }
    function onTouchMove(e: TouchEvent) {
      if (e.touches.length > 1) return;
      const { clientX: x, clientY: y } = e.touches[0];
      const down = y - touchTop.y;
      if (down > 4 && down > Math.abs(x - touchTop.x) && pageScrollsUp(touchPath)) stop();
      if (y < touchTop.y) touchTop = { x, y };
    }
    function onTouchEnd(e: TouchEvent) {
      if (!e.touches.length) forgetTouches();
    }
    function forgetTouches() {
      for (const target of touched) {
        target.removeEventListener("touchmove", onTouchMove);
        target.removeEventListener("touchend", onTouchEnd);
        target.removeEventListener("touchcancel", onTouchEnd);
      }
      touched.clear();
    }
    function onKeyDown(e: KeyboardEvent) {
      if ((SCROLL_UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) && !isEditable(e.target) && pageScrollsUp(e.composedPath())) stop();
    }
    // A press on the page scrollbar, or the middle button (autoscroll)
    function onPointerDown(e: PointerEvent) {
      if (e.button === 1 || e.clientX >= document.documentElement.clientWidth) stop();
    }

    // The first pin waits for the next frame. Sending resizes the composer, which
    // briefly collapses it to measure, and that can move the page in some browsers.
    frame = requestAnimationFrame(tick);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      forgetTouches();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isStreaming]);

  return endRef;
}
