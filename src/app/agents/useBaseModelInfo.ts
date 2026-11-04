"use client";

import { useEffect, useState } from "react";
import type { BaseModelInfo } from "@/lib/types";

/** What an agent on `baseModel` can have, from GET /api/agents/base-model; null until known. */
export function useBaseModelInfo(baseModel: string): BaseModelInfo | null {
  const [result, setResult] = useState<{ model: string; info: BaseModelInfo } | null>(null);

  useEffect(() => {
    if (!baseModel) return;
    let cancelled = false;
    fetch(`/api/agents/base-model?model=${encodeURIComponent(baseModel)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data?.tools)) return;
        const contextLength = typeof data.contextLength === "number" ? data.contextLength : null;
        setResult({ model: baseModel, info: { tools: data.tools, contextLength } });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [baseModel]);

  // Until the new model's answer arrives, the previous model's does not apply
  return result?.model === baseModel ? result.info : null;
}
