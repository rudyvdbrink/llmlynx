"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../chat/sidebar/Sidebar";
import chatStyles from "../chat/Chat.module.css";
import styles from "./Agents.module.css";

type User = { id: string; email: string } | null;
type ConversationSummary = {
  id: string;
  title: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
};

type AgentOptions = {
  mirostat: number;         // 0 = off, 1 = Mirostat, 2 = Mirostat 2.0
  mirostat_eta: number;     // η
  mirostat_tau: number;     // τ
  num_ctx: number;
  repeat_last_n: number;
  repeat_penalty: number;
  temperature: number;
  seed: number;
  num_predict: number;
  top_k: number;
  top_p: number;
  min_p: number;
};

type AgentSummary = {
  id: string;
  name: string;
  baseModel: string;
  systemPrompt?: string | null;
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_OPTS: AgentOptions = {
  mirostat: 0,
  mirostat_eta: 0.1,
  mirostat_tau: 5.0,
  num_ctx: 2048,
  repeat_last_n: 64,
  repeat_penalty: 1.1,
  temperature: 0.8,
  seed: 0,
  num_predict: -1,
  top_k: 40,
  top_p: 0.9,
  min_p: 0.0,
};

// Selection for the dropdown: either a raw model or an agent
type Selection =
  | { kind: "model"; value: string }  // value = model name
  | { kind: "agent"; value: string }; // value = agent id

export default function AgentsPage() {
  // Sidebar state
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [user, setUser] = useState<User>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarModel, setSidebarModel] = useState("gpt-oss:20b");

  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 760) {
      setCollapsed(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me")
      .then((r) => r.json().catch(() => ({ user: null })))
      .then((data) => {
        if (active) setUser(data.user ?? null);
      })
      .catch(() => {
        if (active) setUser(null);
      });
    return () => {
      active = false;
    };
  }, []);

  function refreshConversations() {
    if (!user) {
      setConversations([]);
      return;
    }
    fetch("/api/conversations")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setConversations(data.conversations ?? []))
      .catch(() => setConversations([]));
  }

  useEffect(() => {
    refreshConversations();
    if (!user) setActiveConversationId(null);
  }, [user]);

  function onOpenConversation(_id: string) {
    window.location.href = "/chat";
  }
  function onNewConversation() {
    window.location.href = "/chat";
  }

  // Agent form state (UI)
  const [agentName, setAgentName] = useState("");
  const [baseModel, setBaseModel] = useState<string>("gpt-oss:20b"); // underlying model tag
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: "model", value: "gpt-oss:20b" });

  const [systemPrompt, setSystemPrompt] = useState<string>("");
  const [opts, setOpts] = useState<AgentOptions>(DEFAULT_OPTS);

  // Current agent id when editing an existing one (selection.kind === "agent")
  const [agentId, setAgentId] = useState<string | null>(null);

  // UI feedback
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error"; msg: string } | null>(null);

  // Load local Ollama models
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
        if (names.length) {
          setAvailableModels(names);
          // If current selection is a model, keep it if it's still present; otherwise pick the first
          setSelection((prev) =>
            prev.kind === "model"
              ? { kind: "model", value: names.includes(prev.value) ? prev.value : names[0] }
              : prev
          );
          setBaseModel((prev) => (names.includes(prev) ? prev : names[0]));
        } else {
          throw new Error("no models");
        }
      })
      .catch(() => {
        const fallback = ["gpt-oss:20b", "gemma3:1b", "gemma3:12b", "mistral"];
        setAvailableModels(fallback);
        setSelection((prev) =>
          prev.kind === "model"
            ? { kind: "model", value: fallback.includes(prev.value) ? prev.value : fallback[0] }
            : prev
        );
        setBaseModel((prev) => (fallback.includes(prev) ? prev : fallback[0]));
      });
    return () => {
      active = false;
    };
  }, []);

  // Load user agents
  useEffect(() => {
    if (!user) {
      setAgents([]);
      return;
    }
    let active = true;
    fetch("/api/agents")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (!active) return;
        const list: AgentSummary[] = Array.isArray(data?.agents) ? data.agents : [];
        setAgents(list);
      })
      .catch(() => setAgents([]));
    return () => {
      active = false;
    };
  }, [user]);

  function setOpt<K extends keyof AgentOptions>(key: K, value: AgentOptions[K]) {
    setOpts((prev) => ({ ...prev, [key]: value }));
  }

  // Include `saving` in deps so we can pass disabled={saving} into inputs
  const optRows = useMemo(
    () => [
      {
        key: "mirostat",
        label: "Mirostat",
        control: (
          <select
            className={styles.inlineSelect}
            value={opts.mirostat}
            onChange={(e) => setOpt("mirostat", parseInt(e.target.value, 10))}
            disabled={saving}
          >
            <option value={0}>Off</option>
            <option value={1}>Mirostat</option>
            <option value={2}>Mirostat 2.0</option>
          </select>
        ),
        numeric: null,
      },
      {
        key: "mirostat_eta",
        label: "Mirostat η",
        control: (
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={opts.mirostat_eta}
            onChange={(e) => setOpt("mirostat_eta", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
        numeric: (
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={opts.mirostat_eta}
            onChange={(e) => setOpt("mirostat_eta", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
      },
      {
        key: "mirostat_tau",
        label: "Mirostat τ",
        control: (
          <input
            type="range"
            min={0}
            max={10}
            step={0.1}
            value={opts.mirostat_tau}
            onChange={(e) => setOpt("mirostat_tau", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
        numeric: (
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={opts.mirostat_tau}
            onChange={(e) => setOpt("mirostat_tau", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
      },
      {
        key: "num_ctx",
        label: "Context window (tokens)",
        control: (
          <input
            type="range"
            min={256}
            max={32768}
            step={256}
            value={opts.num_ctx}
            onChange={(e) => setOpt("num_ctx", parseInt(e.target.value, 10))}
            disabled={saving}
          />
        ),
        numeric: (
          <input
            type="number"
            min={1}
            step={1}
            value={opts.num_ctx}
            onChange={(e) => setOpt("num_ctx", parseInt(e.target.value, 10) || 0)}
            disabled={saving}
          />
        ),
      },
      {
        key: "repeat_last_n",
        label: "Repetition lookback (last n)",
        control: (
          <input
            type="range"
            min={-1}
            max={4096}
            step={1}
            value={opts.repeat_last_n}
            onChange={(e) => setOpt("repeat_last_n", parseInt(e.target.value, 10))}
            disabled={saving}
          />
        ),
        numeric: (
          <input
            type="number"
            min={-1}
            step={1}
            value={opts.repeat_last_n}
            onChange={(e) => setOpt("repeat_last_n", parseInt(e.target.value, 10))}
            disabled={saving}
          />
        ),
      },
      {
        key: "repeat_penalty",
        label: "Repetition penalty",
        control: (
          <input
            type="range"
            min={0}
            max={3}
            step={0.05}
            value={opts.repeat_penalty}
            onChange={(e) => setOpt("repeat_penalty", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
        numeric: (
          <input
            type="number"
            min={0}
            max={3}
            step={0.05}
            value={opts.repeat_penalty}
            onChange={(e) => setOpt("repeat_penalty", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
      },
      {
        key: "temperature",
        label: "Temperature",
        control: (
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={opts.temperature}
            onChange={(e) => setOpt("temperature", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
        numeric: (
          <input
            type="number"
            min={0}
            max={2}
            step={0.05}
            value={opts.temperature}
            onChange={(e) => setOpt("temperature", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
      },
      {
        key: "seed",
        label: "Random number seed",
        control: null,
        numeric: (
          <input
            className={styles.seedNumber}
            type="number"
            step={1}
            value={opts.seed}
            onChange={(e) => setOpt("seed", parseInt(e.target.value, 10) || 0)}
            disabled={saving}
          />
        ),
      },
      {
        key: "num_predict",
        label: "Max tokens to generate",
        control: (
          <input
            type="range"
            min={-1}
            max={8192}
            step={1}
            value={opts.num_predict}
            onChange={(e) => setOpt("num_predict", parseInt(e.target.value, 10))}
            disabled={saving}
          />
        ),
        numeric: (
          <input
            type="number"
            step={1}
            value={opts.num_predict}
            onChange={(e) => setOpt("num_predict", parseInt(e.target.value, 10))}
            disabled={saving}
          />
        ),
      },
      {
        key: "top_k",
        label: "Top‑k",
        control: (
          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={opts.top_k}
            onChange={(e) => setOpt("top_k", parseInt(e.target.value, 10))}
            disabled={saving}
          />
        ),
        numeric: (
          <input
            type="number"
            min={0}
            step={1}
            value={opts.top_k}
            onChange={(e) => setOpt("top_k", parseInt(e.target.value, 10))}
            disabled={saving}
          />
        ),
      },
      {
        key: "top_p",
        label: "Top‑p",
        control: (
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={opts.top_p}
            onChange={(e) => setOpt("top_p", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
        numeric: (
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={opts.top_p}
            onChange={(e) => setOpt("top_p", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
      },
      {
        key: "min_p",
        label: "Min‑p",
        control: (
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={opts.min_p}
            onChange={(e) => setOpt("min_p", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
        numeric: (
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={opts.min_p}
            onChange={(e) => setOpt("min_p", parseFloat(e.target.value))}
            disabled={saving}
          />
        ),
      },
    ],
    [opts, saving]
  );

  // Compose select value string
  const selectValue = selection.kind === "agent" ? `agent:${selection.value}` : `model:${selection.value}`;

  // Handle selection changes
  async function onChangeSelection(e: React.ChangeEvent<HTMLSelectElement>) {
    const raw = e.target.value || "";
    if (raw.startsWith("agent:")) {
      const id = raw.slice("agent:".length);
      // Load the agent and prefill
      try {
        setStatus(null);
        const res = await fetch(`/api/agents/${id}`);
        if (!res.ok) throw new Error("Failed to load agent");
        const data = await res.json();
        const a = data?.agent;
        if (!a) throw new Error("Invalid agent payload");
        setSelection({ kind: "agent", value: id });
        setAgentId(id);
        setAgentName(a.name ?? "");
        setBaseModel(a.baseModel ?? baseModel); // keep old baseModel if missing
        setSystemPrompt(a.systemPrompt ?? "");
        // Apply settings with sane fallback to defaults
        const s = a.settings || {};
        setOpts({
          ...DEFAULT_OPTS,
          ...(s as Partial<AgentOptions>),
        });
      } catch (err: any) {
        setStatus({ kind: "error", msg: err?.message || "Failed to load agent" });
        // Fallback to model selection
        setSelection({ kind: "model", value: baseModel });
        setAgentId(null);
      }
    } else if (raw.startsWith("model:")) {
      const modelName = raw.slice("model:".length);
      setSelection({ kind: "model", value: modelName });
      setBaseModel(modelName);
      setAgentId(null); // new agent (Save)
      // Optional: keep user-entered name/prompt/options as-is so they can save quickly
    } else {
      // Unknown value, ignore
    }
  }

  function buildPayload() {
    return {
      name: agentName.trim(),
      baseModel: baseModel.trim(),
      systemPrompt: systemPrompt,
      settings: { ...opts },
    };
  }

  const isEditingExisting = selection.kind === "agent" && !!agentId;

  async function onSave() {
    setStatus(null);
    if (!agentName.trim()) {
      setStatus({ kind: "error", msg: "Please enter an agent name." });
      return;
    }
    if (!baseModel.trim()) {
      setStatus({ kind: "error", msg: "Please select a base model." });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || `Save failed (${res.status})`);
      }
      const created = data?.agent as AgentSummary & { settings?: AgentOptions };
      if (created?.id) {
        // Add to agents list (make it available in dropdown)
        setAgents((prev) => {
          const exists = prev.some((a) => a.id === created.id);
          return exists ? prev : [{ id: created.id, name: created.name, baseModel: created.baseModel, systemPrompt: created.systemPrompt, createdAt: created.createdAt, updatedAt: created.updatedAt }, ...prev];
        });
        // Flip to "Update" by selecting this agent
        setAgentId(created.id);
        setSelection({ kind: "agent", value: created.id });
        setStatus({ kind: "success", msg: "Agent saved." });
      } else {
        setStatus({ kind: "success", msg: "Agent saved." });
      }
    } catch (e: any) {
      setStatus({ kind: "error", msg: e?.message || "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  async function onUpdate() {
    if (!agentId) return;
    setStatus(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || `Update failed (${res.status})`);
      }
      // Update the local agents list metadata (name, updatedAt) if changed
      setAgents((prev) =>
        prev.map((a) =>
          a.id === agentId
            ? {
                ...a,
                name: agentName.trim() || a.name,
                baseModel: baseModel.trim() || a.baseModel,
                updatedAt: new Date().toISOString(),
              }
            : a
        )
      );
      setStatus({ kind: "success", msg: "Agent updated." });
    } catch (e: any) {
      setStatus({ kind: "error", msg: e?.message || "Update failed." });
    } finally {
      setSaving(false);
    }
  }

  function handlePrimaryAction() {
    if (isEditingExisting) onUpdate();
    else onSave();
  }

  return (
    <main className={chatStyles.page}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        user={user}
        model={sidebarModel}
        onChangeModel={setSidebarModel}
        modelDisabled={false}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onNewConversation={onNewConversation}
        onOpenConversation={onOpenConversation}
        footerNavLabel="Back to chat"
        footerNavHref="/chat"
      />

      <div className={`${chatStyles.chatArea} ${styles.agentsArea}`}>
        {/* Feedback banner */}
        {status && (
          <div
            role="status"
            aria-live="polite"
            style={{
              marginBottom: 8,
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: status.kind === "success" ? "#0f1e2f" : "#2a1212",
              color: "var(--text)",
            }}
          >
            {status.msg}
          </div>
        )}

        {/* Header inputs with section-sized titles */}
        <section className={styles.headerRow}>
          <div className={styles.fieldGroup}>
            <h2 className={styles.sectionTitle}>Agent name</h2>
            <input
              className={styles.textInput}
              type="text"
              placeholder="e.g. Research Copilot"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              disabled={saving}
            />
          </div>

          <div className={styles.fieldGroup}>
            <h2 className={styles.sectionTitle}>Base model</h2>
            <select
              className={styles.select}
              value={selectValue}
              onChange={onChangeSelection}
              disabled={saving}
            >
              {agents.length > 0 && (
                <optgroup label="Agents">
                  {agents.map((a) => (
                    <option key={a.id} value={`agent:${a.id}`}>
                      {a.name} {a.baseModel ? `(${a.baseModel})` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Base models">
                {availableModels.map((m) => (
                  <option key={m} value={`model:${m}`}>
                    {m}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          <div className={styles.actionsBlock}>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={handlePrimaryAction}
              disabled={saving}
              title={isEditingExisting ? "Update this agent" : "Create a new agent"}
            >
              {saving ? (isEditingExisting ? "Updating..." : "Saving...") : isEditingExisting ? "Update" : "Save agent"}
            </button>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>System prompt</h2>
          <textarea
            className={styles.promptArea}
            rows={8}
            placeholder="Describe how this agent should behave..."
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            disabled={saving}
          />
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Generation options</h2>
          <div className={styles.grid}>
            {optRows.map((row) => (
              <div key={row.key} className={styles.optionRow}>
                <label className={styles.optionLabel}>{row.label}</label>
                <div className={styles.optionControls}>
                  {row.control ?? <div className={styles.controlPlaceholder} />}
                  {row.numeric && <div className={styles.numberWrap}>{row.numeric}</div>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.footerActions}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => {
              const dlg = document.querySelector<HTMLDialogElement>("dialog." + styles.helpDialog);
              dlg?.showModal?.();
            }}
            disabled={saving}
          >
            Help
          </button>
          <button
            type="button"
            className={styles.resetBtn}
            onClick={() => {
              setOpts(DEFAULT_OPTS);
              setStatus(null);
            }}
            disabled={saving}
          >
            Reset to defaults
          </button>
        </section>
      </div>

      <dialog className={styles.helpDialog}>
        <div className={styles.helpContent}>
          <div className={styles.helpHeader}>
            <h3>Agent options</h3>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={(e) => (e.currentTarget.closest("dialog") as HTMLDialogElement | null)?.close()}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className={styles.helpBody}>
            <dl className={styles.helpList}>
              <dt>Mirostat</dt>
              <dd>Enable Mirostat sampling for controlling perplexity. (Off, Mirostat, Mirostat 2.0)</dd>
              <dt>Mirostat η</dt>
              <dd>Learning rate for Mirostat; higher is more responsive. Default 0.1.</dd>
              <dt>Mirostat τ</dt>
              <dd>Balance coherence vs. diversity; lower = more focused. Default 5.0.</dd>
              <dt>Context window (tokens)</dt>
              <dd>Context window size in tokens. Default 2048.</dd>
              <dt>Repetition lookback (last n)</dt>
              <dd>Lookback window for repetition penalty. 0=disabled, -1=num_ctx. Default 64.</dd>
              <dt>Repetition penalty</dt>
              <dd>Strength of repetition penalty; higher penalizes more. Default 1.1.</dd>
              <dt>Temperature</dt>
              <dd>Creativity of the model; higher = more diverse outputs. Default 0.8.</dd>
              <dt>Random number seed</dt>
              <dd>Same seed yields repeatable output. Default 0.</dd>
              <dt>Max tokens to generate</dt>
              <dd>Max tokens to generate. -1 for no limit. Default -1.</dd>
              <dt>Top‑k</dt>
              <dd>Sample from top‑k tokens; higher = more diverse. Default 40.</dd>
              <dt>Top‑p</dt>
              <dd>Nucleus sampling; higher = more diverse. Default 0.9.</dd>
              <dt>Min‑p</dt>
              <dd>Minimum probability threshold relative to the max token probability. Default 0.0.</dd>
            </dl>
          </div>
        </div>
      </dialog>
    </main>
  );
}