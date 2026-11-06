"use client";

import { useEffect, useState } from "react";
import type { BaseModelInfo } from "@/lib/types";

/**
 * What an agent on `selection` (a provider's model) can have, from GET
 * /api/agents/base-model. While the answer for a new model loads, the previous
 * model's answer stays available in `shown`, so the page can dim it rather than
 * empty it. `info` is null in `shown` when the request failed.
 */
export function useBaseModelInfo(selection: string) {
  const [shown, setShown] = useState<{ model: string; info: BaseModelInfo | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agents/base-model?model=${encodeURIComponent(selection)}`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => {
        if (cancelled) return;
        setShown({ model: selection, info: Array.isArray(data?.tools) ? (data as BaseModelInfo) : null });
      });
    return () => {
      cancelled = true;
    };
  }, [selection]);

  const loading = shown?.model !== selection;
  return { shown, loading, info: loading ? null : shown.info };
}
