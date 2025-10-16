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

export default function AgentsPage() {
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

  const [agentName, setAgentName] = useState("");
  const [baseModel, setBaseModel] = useState<string>("gpt-oss:20b");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [systemPrompt, setSystemPrompt] = useState<string>("");

  const [opts, setOpts] = useState<AgentOptions>(DEFAULT_OPTS);

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
          setBaseModel(names[0]);
        } else {
          throw new Error("no models");
        }
      })
      .catch(() => {
        const fallback = ["gpt-oss:20b", "gemma3:1b", "gemma3:12b", "mistral"];
        setAvailableModels(fallback);
        setBaseModel((prev) => (fallback.includes(prev) ? prev : fallback[0]));
      });
    return () => {
      active = false;
    };
  }, []);

  const helpOpenRef = useRef<HTMLDialogElement | null>(null);
  function openHelp() {
    helpOpenRef.current?.showModal?.();
  }
  function closeHelp() {
    helpOpenRef.current?.close?.();
  }

  function setOpt<K extends keyof AgentOptions>(key: K, value: AgentOptions[K]) {
    setOpts((prev) => ({ ...prev, [key]: value }));
  }

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
          />
        ),
        numeric: (
          <input
            type="number"
            min={1}
            step={1}
            value={opts.num_ctx}
            onChange={(e) => setOpt("num_ctx", parseInt(e.target.value, 10) || 0)}
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
          />
        ),
        numeric: (
          <input
            type="number"
            min={-1}
            step={1}
            value={opts.repeat_last_n}
            onChange={(e) => setOpt("repeat_last_n", parseInt(e.target.value, 10))}
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
          />
        ),
        numeric: (
          <input
            type="number"
            step={1}
            value={opts.num_predict}
            onChange={(e) => setOpt("num_predict", parseInt(e.target.value, 10))}
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
          />
        ),
        numeric: (
          <input
            type="number"
            min={0}
            step={1}
            value={opts.top_k}
            onChange={(e) => setOpt("top_k", parseInt(e.target.value, 10))}
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
          />
        ),
      },
    ],
    [opts]
  );

  function resetToDefaults() {
    setOpts(DEFAULT_OPTS);
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
        <section className={styles.headerRow}>
          <div className={styles.fieldGroup}>
            <h2 className={styles.sectionTitle}>Agent name</h2>
            <input
              className={styles.textInput}
              type="text"
              placeholder="e.g. Research Copilot"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            />
          </div>

          <div className={styles.fieldGroup}>
            <h2 className={styles.sectionTitle}>Base model</h2>
            <select
              className={styles.select}
              value={baseModel}
              onChange={(e) => setBaseModel(e.target.value)}
            >
              {availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.actionsBlock}>
            <button type="button" className={styles.primaryBtn} onClick={() => { /* TODO: save */ }}>
              Save agent
            </button>
            <button type="button" className={styles.secondaryBtn} onClick={() => { /* TODO: update */ }}>
              Update
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
          <button type="button" className={styles.secondaryBtn} onClick={openHelp}>
            Help
          </button>
          <button type="button" className={styles.resetBtn} onClick={resetToDefaults}>
            Reset to defaults
          </button>
        </section>
      </div>

      <dialog ref={helpOpenRef} className={styles.helpDialog}>
        <div className={styles.helpContent}>
          <div className={styles.helpHeader}>
            <h3>Agent options</h3>
            <button type="button" className={styles.closeBtn} onClick={closeHelp} aria-label="Close">
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