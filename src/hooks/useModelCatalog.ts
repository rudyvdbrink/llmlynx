"use client";

import { useEffect, useState } from "react";
import { FALLBACK_MODELS } from "@/lib/selection";
import type { AgentSummary } from "@/lib/types";

// Loads `url` once on mount. `pick` extracts the value from the JSON body;
// `fallback` is used when the request fails. Both must be stable references.
function useFetchedList<T>(url: string, pick: (data: unknown) => T[], fallback: T[]) {
  const [items, setItems] = useState<T[]>([]);

  useEffect(() => {
    let active = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => pick(data))
      .catch(() => fallback)
      .then((list) => {
        if (active) setItems(list);
      });
    return () => {
      active = false;
    };
  }, [url, pick, fallback]);

  return [items, setItems] as const;
}

const NO_ITEMS: never[] = [];

const pickModelNames = (data: unknown) => {
  const models = (data as { models?: { name?: string }[] })?.models;
  return Array.isArray(models) ? models.map((m) => m?.name).filter((n): n is string => !!n) : [];
};

const pickAgents = (data: unknown) => {
  const agents = (data as { agents?: AgentSummary[] })?.agents;
  return Array.isArray(agents) ? agents : [];
};

const pickRemoteModels = (data: unknown) => {
  const d = data as { available?: boolean; models?: string[] };
  return d?.available && Array.isArray(d.models) ? d.models : [];
};

/** Names of the models installed on Ollama, or a static fallback list if Ollama is unreachable. */
export function useLocalModels(): string[] {
  return useFetchedList("/api/models", pickModelNames, FALLBACK_MODELS)[0];
}

/** The current user's agents. The setter allows local updates after a save. */
export function useAgentList() {
  return useFetchedList<AgentSummary>("/api/agents", pickAgents, NO_ITEMS);
}

/** Remote (OpenAI) models, empty when no API key is configured. */
export function useRemoteModels(): string[] {
  return useFetchedList<string>("/api/remote-models", pickRemoteModels, NO_ITEMS)[0];
}
