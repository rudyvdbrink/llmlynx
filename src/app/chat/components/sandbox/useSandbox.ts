"use client";

import { useEffect, useState } from "react";
import type { SandboxView } from "@/lib/sandbox";

/**
 * The sandbox of the chat `conversationId`, for the sandbox panel. It loads
 * while the panel is open (`active`), and again when `tick` changes: when a
 * run, an install or a download of the reply ends, and when `reload` is called.
 */
export function useSandbox(conversationId: string | null, active: boolean, tick: number) {
  const [view, setView] = useState<{ conversationId: string; data: SandboxView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!active || !conversationId) return;
    const abort = new AbortController();
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/sandbox`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`The sandbox could not be loaded (status ${res.status})`);
        return (await res.json()) as SandboxView;
      })
      .then(
        (data) => {
          setView({ conversationId, data });
          setError(null);
        },
        (err) => {
          if ((err as Error)?.name !== "AbortError") setError((err as Error)?.message || "The sandbox could not be loaded");
        }
      );
    return () => abort.abort();
  }, [active, conversationId, tick, reloads]);

  // Another chat's sandbox is never shown, not even while this one loads
  const data = view && view.conversationId === conversationId ? view.data : null;
  return { data, error, reload: () => setReloads((n) => n + 1) };
}
