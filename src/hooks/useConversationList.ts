"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "@/lib/types";

/** The current user's conversations, most recent first. */
export function useConversationList() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  // Only the latest request may update the list, so a slow response cannot overwrite a newer one.
  const latestRequest = useRef(0);

  const refresh = useCallback(() => {
    const request = ++latestRequest.current;
    fetch("/api/conversations")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => data.conversations ?? [])
      .catch(() => [])
      .then((list: ConversationSummary[]) => {
        if (request === latestRequest.current) setConversations(list);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { conversations, refresh };
}
