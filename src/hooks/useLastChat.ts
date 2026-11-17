"use client";

import { useSyncExternalStore } from "react";

// The conversation open on the chat page, kept per browser tab, so the pages
// that link back to the chat (agents, account) return to it
const KEY = "llmlynx:lastConversation";

/** Keeps `id` as the chat to return to; null when a new conversation is open. */
export function rememberChat(id: string | null) {
  try {
    if (id) sessionStorage.setItem(KEY, id);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the way back opens a new conversation
  }
}

function lastChat(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// Read once per render; nothing changes it while these pages are open
const noSubscription = () => () => {};

/** Link back to the chat page, to the conversation that was open there in this tab. */
export function useLastChatHref(): string {
  const id = useSyncExternalStore(noSubscription, lastChat, () => null);
  return id ? `/chat?conversation=${encodeURIComponent(id)}` : "/chat";
}
