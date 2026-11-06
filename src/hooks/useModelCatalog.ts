"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FALLBACK_MODELS, sortAgents } from "@/lib/selection";
import type { ProviderId, ProviderSettings } from "@/lib/providers";
import type { AgentStatus, AgentSummary } from "@/lib/types";

// Counts events of this name; used as an effect dependency to reload.
function useEventCount(name: string) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const bump = () => setCount((c) => c + 1);
    window.addEventListener(name, bump);
    return () => window.removeEventListener(name, bump);
  }, [name]);
  return count;
}

// Loads `url` on mount and when `version` changes. `pick` extracts the value from
// the JSON body; `fallback` is used when the request fails. Both must be stable references.
function useFetchedList<T>(url: string, pick: (data: unknown) => T[], fallback: T[], version: number) {
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
  }, [url, pick, fallback, version]);

  return [items, setItems] as const;
}

const NO_ITEMS: never[] = [];

const pickAgents = (data: unknown) => {
  const agents = (data as { agents?: AgentSummary[] })?.agents;
  return Array.isArray(agents) ? sortAgents(agents) : [];
};

// Fired after the agents page saves or deletes an agent, so that every list of agents on the page is loaded again.
const AGENTS_CHANGED = "llmlynx:agents-changed";

export function notifyAgentsChanged() {
  window.dispatchEvent(new Event(AGENTS_CHANGED));
}

/** The current user's agents. */
export function useAgentList() {
  return useFetchedList<AgentSummary>("/api/agents", pickAgents, NO_ITEMS, useEventCount(AGENTS_CHANGED));
}

// Fired after the account page saves or removes a provider setting, so that
// provider settings and model lists already on the page are loaded again.
const PROVIDERS_CHANGED = "llmlynx:providers-changed";

export function notifyProvidersChanged() {
  window.dispatchEvent(new Event(PROVIDERS_CHANGED));
}

/** What the current user has set up per provider; null while loading or when the request fails. */
export function useProviderSettings(): ProviderSettings | null {
  const version = useEventCount(PROVIDERS_CHANGED);
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

/**
 * Whether each of the current user's agents can be used now, per agent id. Empty
 * until known, so that agents are not greyed out while this loads. `refresh`
 * asks again, as a provider that was down may be back.
 */
export function useAgentStatuses() {
  const providersVersion = useEventCount(PROVIDERS_CHANGED);
  const agentsVersion = useEventCount(AGENTS_CHANGED);
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const latestRef = useRef(0);

  const refresh = useCallback(() => {
    const request = ++latestRef.current;
    fetch("/api/agents/status")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (request === latestRef.current) setStatuses(data?.statuses ?? {});
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, providersVersion, agentsVersion]);

  return { statuses, refresh };
}

type ModelListResult = { provider: ProviderId; models: string[]; expiries: Record<string, string>; error: string | null };

const NO_EXPIRIES: Record<string, string> = {};

/**
 * The models `provider` offers the current user, sorted by name, and the
 * announced last day of those that have one. When Ollama cannot be reached, a
 * static fallback list comes back together with the error.
 */
export function useProviderModels(provider: ProviderId | null) {
  const version = useEventCount(PROVIDERS_CHANGED);
  const [result, setResult] = useState<ModelListResult | null>(null);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    fetch(`/api/providers/${provider}/models`)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(data?.message || `Failed to load models (${r.status})`);
        return {
          models: Array.isArray(data?.models) ? (data.models as string[]) : [],
          expiries: (data?.expiries as Record<string, string> | undefined) ?? NO_EXPIRIES,
        };
      })
      .then(
        (listing) => ({ ...listing, error: null }),
        (err: Error) => ({
          models: provider === "ollama" ? FALLBACK_MODELS : [],
          expiries: NO_EXPIRIES,
          error: err.message,
        })
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
    expiries: current?.expiries ?? NO_EXPIRIES,
    loading: provider !== null && current === null,
    error: current?.error ?? null,
  };
}
