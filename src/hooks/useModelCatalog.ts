"use client";

import { useEffect, useState } from "react";
import { FALLBACK_MODELS } from "@/lib/selection";
import type { ProviderId, ProviderSettings } from "@/lib/providers";
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

const pickAgents = (data: unknown) => {
  const agents = (data as { agents?: AgentSummary[] })?.agents;
  return Array.isArray(agents) ? agents : [];
};

/** The current user's agents. The setter allows local updates after a save. */
export function useAgentList() {
  return useFetchedList<AgentSummary>("/api/agents", pickAgents, NO_ITEMS);
}

// Fired after the account page saves or removes a provider setting, so that
// provider settings and model lists already on the page are loaded again.
const PROVIDERS_CHANGED = "llmlynx:providers-changed";

export function notifyProvidersChanged() {
  window.dispatchEvent(new Event(PROVIDERS_CHANGED));
}

// Counts PROVIDERS_CHANGED events; used as an effect dependency to reload.
function useProvidersVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(PROVIDERS_CHANGED, bump);
    return () => window.removeEventListener(PROVIDERS_CHANGED, bump);
  }, []);
  return version;
}

/** What the current user has set up per provider; null while loading or when the request fails. */
export function useProviderSettings(): ProviderSettings | null {
  const version = useProvidersVersion();
  const [settings, setSettings] = useState<ProviderSettings | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/providers")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (active) setSettings(data?.settings ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [version]);

  return settings;
}

type ModelListResult = { provider: ProviderId; models: string[]; error: string | null };

/**
 * The models `provider` offers the current user, sorted by name. When Ollama
 * cannot be reached, a static fallback list comes back together with the error.
 */
export function useProviderModels(provider: ProviderId | null) {
  const version = useProvidersVersion();
  const [result, setResult] = useState<ModelListResult | null>(null);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    fetch(`/api/providers/${provider}/models`)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(data?.message || `Failed to load models (${r.status})`);
        return Array.isArray(data?.models) ? (data.models as string[]) : [];
      })
      .then(
        (models) => ({ models, error: null }),
        (err: Error) => ({ models: provider === "ollama" ? FALLBACK_MODELS : [], error: err.message })
      )
      .then((list) => {
        if (active) setResult({ provider, ...list });
      });
    return () => {
      active = false;
    };
  }, [provider, version]);

  // A result for another provider is stale while the list for this one loads.
  const current = result?.provider === provider ? result : null;
  return {
    models: current?.models ?? NO_ITEMS,
    loading: provider !== null && current === null,
    error: current?.error ?? null,
  };
}

/** Names of the models on the user's Ollama server, or a static fallback list if it is unreachable. */
export function useLocalModels(): string[] {
  return useProviderModels("ollama").models;
}
