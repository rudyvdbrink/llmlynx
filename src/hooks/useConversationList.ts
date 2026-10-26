"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RECENT_DAYS, startOfDay } from "@/lib/dateGroups";
import type { ConversationSummary } from "@/lib/types";

// Older conversations are loaded this many at a time. While searching, the
// first page of older matches is shown right away.
const OLDER_PAGE_SIZE = 30;
const SEARCH_DELAY_MS = 250;

type ListData = { key: string; conversations: ConversationSummary[]; hasOlder: boolean };

/**
 * The current user's conversations: pinned ones first, then those of the
 * last RECENT_DAYS days, most recent first, plus older ones after `loadOlder`.
 * `query` filters by title and message text.
 */
export function useConversationList() {
  // Fixed for the life of the page, so a refresh returns the same range.
  const [since] = useState(() => startOfDay(RECENT_DAYS).toISOString());
  const [query, setQuery] = useState("");
  const [olderPages, setOlderPages] = useState(0);
  const [data, setData] = useState<ListData>({ key: "", conversations: [], hasOlder: false });
  // Only the latest request may update the list, so a slow response cannot overwrite a newer one.
  const latestRequest = useRef(0);

  const q = query.trim();
  const older = (olderPages + (q ? 1 : 0)) * OLDER_PAGE_SIZE;
  const key = `${q}|${older}`;

  const refresh = useCallback(() => {
    const request = ++latestRequest.current;
    const params = new URLSearchParams({ since, older: String(older) });
    if (q) params.set("q", q);
    fetch(`/api/conversations?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => ({ conversations: d.conversations ?? [], hasOlder: !!d.hasOlder }))
      .catch(() => ({ conversations: [], hasOlder: false }))
      .then((list) => {
        if (request === latestRequest.current) setData({ key, ...list });
      });
  }, [since, older, q, key]);

  // Load on mount and whenever the search or the number of older pages changes;
  // typing is debounced.
  useEffect(() => {
    const timer = setTimeout(refresh, q ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [refresh, q]);

  const loadOlder = useCallback(() => setOlderPages((n) => n + 1), []);

  const setPinned = useCallback(
    async (id: string, pinned: boolean) => {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      }).catch(() => {});
      refresh();
    },
    [refresh]
  );

  return {
    conversations: data.conversations,
    hasOlder: data.hasOlder,
    // True until the list matches the current search and page count.
    loading: data.key !== key,
    query,
    setQuery,
    loadOlder,
    setPinned,
    refresh,
  };
}

export type ConversationList = ReturnType<typeof useConversationList>;
