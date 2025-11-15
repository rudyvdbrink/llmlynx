"use client";

import { useEffect, useState } from "react";
import styles from "./Sidebar.module.css";

type AgentSummary = {
  id: string;
  name: string;
  baseModel: string;
  systemPrompt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export default function ModelSection({
  model,
  onChangeModel,
  disabled,
}: {
  // model is a selection string like "model:mistral", "agent:<id>", or "remote:<id>".
  // For backward compatibility, plain model names are also accepted.
  model: string;
  onChangeModel: (v: string) => void;
  disabled?: boolean;
}) {
  const [baseModels, setBaseModels] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [remoteModels, setRemoteModels] = useState<string[]>([]);

  // Normalize incoming value to ensure the select has a matching option
  const normalizedValue =
    model.startsWith("agent:") || model.startsWith("model:") || model.startsWith("remote:")
      ? model
      : `model:${model}`;

  // Load local models from Ollama proxy
  useEffect(() => {
    let active = true;
    fetch("/api/models")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (!active) return;
        const names: string[] =
          data?.models?.map((m: any) => m.name).filter(Boolean) ??
          data?.models?.filter((m: any) => typeof m === "string") ??
          [];
        setBaseModels(names);
      })
      .catch(() => {
        // Fallback to a small static set
        setBaseModels(["gpt-oss:20b", "gemma3:1b", "gemma3:12b", "mistral"]);
      });
    return () => {
      active = false;
    };
  }, []);

  // Load user's saved agents (ignore 401 Unauthorized by treating as empty)
  useEffect(() => {
    let active = true;
    fetch("/api/agents")
      .then(async (r) => {
        if (!r.ok) {
          if (r.status === 401) return { agents: [] };
          throw new Error("failed");
        }
        return r.json();
      })
      .then((data) => {
        if (!active) return;
        const list: AgentSummary[] = Array.isArray(data?.agents) ? data.agents : [];
        setAgents(list);
      })
      .catch(() => setAgents([]));
    return () => {
      active = false;
    };
  }, []);

  // Load remote models availability
  useEffect(() => {
    let active = true;
    fetch("/api/remote-models")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (!active) return;
        const available = !!data?.available;
        const models: string[] = Array.isArray(data?.models) ? data.models : [];
        setRemoteModels(available ? models : []);
      })
      .catch(() => setRemoteModels([]));
    return () => {
      active = false;
    };
  }, []);

  const hasAgents = agents.length > 0;
  const hasRemote = remoteModels.length > 0;

  return (
    <div className={styles.modelBlock}>
      <p className={styles.sidebarTitle} id="model-select-label">
        Model
      </p>
      <select
        aria-labelledby="model-select-label"
        className={styles.modelSelect}
        value={normalizedValue}
        onChange={(e) => onChangeModel(e.target.value)}
        disabled={disabled}
      >
        {hasAgents && (
          <optgroup label="Agents">
            {agents.map((a) => (
              <option key={`agent:${a.id}`} value={`agent:${a.id}`}>
                {a.name} {a.baseModel ? `(${a.baseModel})` : ""}
              </option>
            ))}
          </optgroup>
        )}

        {hasRemote && (
          <optgroup label="Remote">
            {remoteModels.map((m) => (
              <option key={`remote:${m}`} value={`remote:${m}`}>
                {m}
              </option>
            ))}
          </optgroup>
        )}

        <optgroup label="Base models">
          {baseModels.map((m) => (
            <option key={`model:${m}`} value={`model:${m}`}>
              {m}
            </option>
          ))}
        </optgroup>

        {/* Safety net: if current value isn't in lists yet, keep it selectable */}
        {!hasAgents &&
          baseModels.length === 0 &&
          !hasRemote &&
          normalizedValue && <option value={normalizedValue}>{normalizedValue}</option>}
      </select>
    </div>
  );
}