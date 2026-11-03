"use client";

import { useState } from "react";
import styles from "./Sidebar.module.css";
import ModelPicker, { type PickerItem } from "./ModelPicker";
import { useAgentList, useProviderModels, useProviderSettings } from "@/hooks/useModelCatalog";
import { DEFAULT_MODELS, isProviderReady, PROVIDER_LABELS, PROVIDERS } from "@/lib/providers";
import { normalizeSelection, parseSelection, toSelection, type SelectionKind } from "@/lib/selection";

// The provider dropdown lists the model providers, then the user's agents.
const KINDS: SelectionKind[] = [...PROVIDERS, "agent"];
const KIND_LABELS: Record<SelectionKind, string> = { ...PROVIDER_LABELS, agent: "Agents" };

// The model last used per provider, so switching back to a provider restores it.
const lastUsed = new Map<SelectionKind, string>();

export default function ModelSection({
  model,
  onChangeModel,
  disabled,
}: {
  // A selection string (see lib/selection.ts); plain model names are also accepted.
  model: string;
  onChangeModel: (v: string) => void;
  disabled?: boolean;
}) {
  const value = normalizeSelection(model);
  const current = parseSelection(value);
  const isAgent = current.kind === "agent";

  const settings = useProviderSettings();
  const [agents] = useAgentList();
  const { models, loading, error } = useProviderModels(current.kind === "agent" ? null : current.kind);
  const [pickerOpen, setPickerOpen] = useState(false);

  function unavailableReason(kind: SelectionKind): string | null {
    if (kind === "agent") return agents.length > 0 ? null : "none yet";
    // Until the settings have loaded, every provider is offered.
    return !settings || isProviderReady(settings, kind) ? null : "no API key";
  }

  function changeKind(kind: SelectionKind) {
    lastUsed.set(current.kind, current.value);
    const next = lastUsed.get(kind) ?? (kind === "agent" ? agents[0]?.id : DEFAULT_MODELS[kind]);
    if (!next) return;
    onChangeModel(toSelection(kind, next));
    setPickerOpen(true);
  }

  const items: PickerItem[] = isAgent
    ? agents.map((a) => ({ value: a.id, label: a.name, detail: a.baseModel }))
    : models.map((m) => ({ value: m, label: m }));

  // The current selection stays visible even when it is not in the list
  // (still loading, an uninstalled model, or a deleted agent).
  const valueLabel = isAgent ? (agents.find((a) => a.id === current.value)?.name ?? "Unknown agent") : current.value;

  // When Ollama cannot be reached, the list holds common model names instead.
  const notice = error && models.length > 0 ? `${error}. Showing common models.` : error;

  return (
    <div className={styles.modelBlock}>
      <p className={styles.sidebarTitle}>Model</p>
      <select
        aria-label="Provider"
        className={styles.modelSelect}
        value={current.kind}
        onChange={(e) => changeKind(e.target.value as SelectionKind)}
        disabled={disabled}
      >
        {KINDS.map((kind) => {
          const reason = kind === current.kind ? null : unavailableReason(kind);
          return (
            <option key={kind} value={kind} disabled={!!reason}>
              {KIND_LABELS[kind]}
              {reason ? ` (${reason})` : ""}
            </option>
          );
        })}
      </select>
      <ModelPicker
        label={isAgent ? "Agent" : "Model"}
        items={items}
        value={current.value}
        valueLabel={valueLabel}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(picked) => onChangeModel(toSelection(current.kind, picked))}
        loading={loading}
        notice={notice}
        noticeIsError={!!error && models.length === 0}
        emptyText={isAgent ? "No agents yet" : "No models available"}
        searchPlaceholder={isAgent ? "Search agents…" : "Search models…"}
        disabled={disabled}
      />
    </div>
  );
}
