"use client";

import { useEffect, useState } from "react";
import type { AttachAccept } from "@/lib/files";

/**
 * Which files a chat with the agent `agentId` takes, from GET
 * /api/agents/:id/accepts. Null for other chats (only agents take files),
 * while it loads, and when the request fails.
 */
export function useAttachAccept(agentId: string | null): AttachAccept | null {
  const [loaded, setLoaded] = useState<{ agentId: string; accept: AttachAccept | null } | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    fetch(`/api/agents/${encodeURIComponent(agentId)}/accepts`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => {
        if (cancelled) return;
        const accept = data?.accept;
        setLoaded({ agentId, accept: typeof accept?.documents === "boolean" ? (accept as AttachAccept) : null });
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return agentId && loaded?.agentId === agentId ? loaded.accept : null;
}
