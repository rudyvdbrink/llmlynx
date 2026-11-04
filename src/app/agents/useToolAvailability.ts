"use client";

import { useEffect, useState } from "react";
import type { ToolAvailability } from "@/lib/agentTools";

/** Which agent tools `baseModel` can use, from GET /api/tools; null until known. */
export function useToolAvailability(baseModel: string): ToolAvailability[] | null {
  const [result, setResult] = useState<{ model: string; tools: ToolAvailability[] } | null>(null);

  useEffect(() => {
    if (!baseModel) return;
    let cancelled = false;
    fetch(`/api/tools?model=${encodeURIComponent(baseModel)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data?.tools)) setResult({ model: baseModel, tools: data.tools });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [baseModel]);

  // Until the new model's answer arrives, the previous model's does not apply
  return result?.model === baseModel ? result.tools : null;
}
