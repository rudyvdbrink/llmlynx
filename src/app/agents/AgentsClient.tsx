"use client";

import { Fragment, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import { useConversationList } from "@/hooks/useConversationList";
import { useAgentList, useLocalModels } from "@/hooks/useModelCatalog";
import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from "@/lib/agentSettings";
import {
  AGENT_TOOL_INFO,
  AGENT_TOOLS,
  DEFAULT_MAX_TOOL_CALLS,
  MAX_TOOL_CALLS_LIMIT,
  validateAgentTools,
  validateMaxToolCalls,
  type AgentToolName,
} from "@/lib/agentTools";
import { DEFAULT_SELECTION, parseSelection, toSelection } from "@/lib/selection";
import type { AgentSummary, SessionUser } from "@/lib/types";
import chatStyles from "../chat/Chat.module.css";
import styles from "./Agents.module.css";
import { contextStops, DEFAULT_CONTEXT_MAX, OPTION_FIELDS, parseOptionValue, type OptionField } from "./optionFields";
import { useBaseModelInfo } from "./useBaseModelInfo";
import { ToolStepIcon } from "../chat/components/ToolLine";

const DEFAULT_BASE_MODEL = parseSelection(DEFAULT_SELECTION).value;

// Below this context window, web pages crowd out the conversation
const MIN_TOOLS_NUM_CTX = 8192;

type Status = { kind: "success" | "error"; msg: string };

export default function AgentsClient({ initialUser }: { initialUser: SessionUser }) {
  const router = useRouter();

  // Sidebar state (auth ensured by server)
  const conversationList = useConversationList();
  const [sidebarSelection, setSidebarSelection] = useState(DEFAULT_SELECTION);
  const goToChat = () => router.push("/chat");
  const openInChat = (id: string) => router.push(`/chat?conversation=${encodeURIComponent(id)}`);

  // Agent form state (UI)
  const availableModels = useLocalModels();
  const [agents, setAgents] = useAgentList();
  // Set while editing a saved agent; null while creating a new one.
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [baseModelPick, setBaseModelPick] = useState(DEFAULT_BASE_MODEL);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [opts, setOpts] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  // Tools are off until the user checks them
  const [tools, setTools] = useState<AgentToolName[]>([]);
  const [maxToolCalls, setMaxToolCalls] = useState(DEFAULT_MAX_TOOL_CALLS);

  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const helpDialogRef = useRef<HTMLDialogElement | null>(null);

  // The default model may not be installed; for a new agent, fall back to the first installed one.
  const baseModel =
    !agentId && availableModels.length > 0 && !availableModels.includes(baseModelPick)
      ? availableModels[0]
      : baseModelPick;

  const baseModelInfo = useBaseModelInfo(baseModel);
  const toolAvailability = baseModelInfo?.tools ?? null;
  const contextLength = baseModelInfo?.contextLength ?? null;

  function toggleTool(name: AgentToolName, on: boolean) {
    setTools((prev) => AGENT_TOOLS.filter((t) => (t === name ? on : prev.includes(t))));
  }

  function setOpt(key: keyof AgentSettings, value: number) {
    setOpts((prev) => ({ ...prev, [key]: value }));
  }

  function renderControl(field: OptionField) {
    if (field.choices) {
      return (
        <select
          className={styles.inlineSelect}
          value={opts[field.key]}
          onChange={(e) => setOpt(field.key, parseOptionValue(field, e.target.value, false))}
          disabled={saving}
        >
          {field.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
    }
    if (field.contextSlider) {
      const stops = contextStops(contextLength ?? DEFAULT_CONTEXT_MAX);
      const value = opts[field.key];
      // A typed value between two stops shows at the lower one
      const index = Math.max(0, stops.filter((s) => s <= value).length - 1);
      return (
        <input
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={index}
          aria-valuetext={String(value)}
          onChange={(e) => setOpt(field.key, stops[Number(e.target.value)])}
          disabled={saving}
        />
      );
    }
    if (field.slider) {
      return (
        <input
          type="range"
          {...field.slider}
          value={opts[field.key]}
          onChange={(e) => setOpt(field.key, parseOptionValue(field, e.target.value, false))}
          disabled={saving}
        />
      );
    }
    // Keeps numeric-only rows right-aligned
    return <div className={styles.controlPlaceholder} />;
  }

  async function onChangeSelection(e: React.ChangeEvent<HTMLSelectElement>) {
    const { kind, value } = parseSelection(e.target.value);
    if (kind === "agent") {
      try {
        setStatus(null);
        const res = await fetch(`/api/agents/${value}`);
        if (!res.ok) throw new Error("Failed to load agent");
        const data = await res.json();
        const a = data?.agent;
        if (!a) throw new Error("Invalid agent payload");
        setAgentId(value);
        setAgentName(a.name ?? "");
        setBaseModelPick(a.baseModel ?? baseModel);
        setSystemPrompt(a.systemPrompt ?? "");
        setOpts({ ...DEFAULT_AGENT_SETTINGS, ...(a.settings as Partial<AgentSettings>) });
        const savedTools = validateAgentTools(a.tools);
        setTools(savedTools.ok ? savedTools.value : []);
        const savedMax = validateMaxToolCalls(a.maxToolCalls);
        setMaxToolCalls(savedMax.ok ? savedMax.value : DEFAULT_MAX_TOOL_CALLS);
      } catch (err) {
        setStatus({ kind: "error", msg: (err as Error)?.message || "Failed to load agent" });
        setAgentId(null);
      }
    } else if (kind === "ollama") {
      setBaseModelPick(value);
      // Leaving a saved agent for a plain base model starts a new agent without tools
      if (agentId) {
        setTools([]);
        setMaxToolCalls(DEFAULT_MAX_TOOL_CALLS);
      }
      setAgentId(null); // new agent (Save)
    }
  }

  const isEditingExisting = !!agentId;

  // Sends the form to the API. Returns the saved agent, or null after showing an error.
  async function submitAgent(url: string, method: "POST" | "PATCH", failLabel: string) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: agentName.trim(),
        baseModel: baseModel.trim(),
        systemPrompt,
        settings: { ...opts },
        tools,
        maxToolCalls,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || `${failLabel} failed (${res.status})`);
    return data?.agent as AgentSummary | undefined;
  }

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
      const created = await submitAgent("/api/agents", "POST", "Save");
      if (created?.id) {
        const { id, name, baseModel, systemPrompt, createdAt, updatedAt } = created;
        setAgents((prev) =>
          prev.some((a) => a.id === id) ? prev : [{ id, name, baseModel, systemPrompt, createdAt, updatedAt }, ...prev]
        );
        // Switch to editing the newly-created agent
        setBaseModelPick(baseModel);
        setAgentId(id);
      }
      setStatus({ kind: "success", msg: "Agent saved." });
    } catch (e) {
      setStatus({ kind: "error", msg: (e as Error)?.message || "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  async function onUpdate() {
    if (!agentId) return;
    setStatus(null);
    setSaving(true);
    try {
      await submitAgent(`/api/agents/${agentId}`, "PATCH", "Update");
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
    } catch (e) {
      setStatus({ kind: "error", msg: (e as Error)?.message || "Update failed." });
    } finally {
      setSaving(false);
    }
  }

  // The base model dropdown doubles as the agent picker.
  const selectValue = agentId ? toSelection("agent", agentId) : toSelection("ollama", baseModel);

  return (
    <AppShell
      sidebar={{
        user: initialUser,
        model: sidebarSelection,
        onChangeModel: setSidebarSelection,
        modelDisabled: false,
        conversationList,
        activeConversationId: null,
        onNewConversation: goToChat,
        onOpenConversation: openInChat,
        footerNavLabel: "Back to chat",
        footerNavHref: "/chat",
      }}
    >
      <div className={`${chatStyles.chatArea} ${styles.agentsArea}`}>
        {/* Feedback banner */}
        {status && (
          <div
            role="status"
            aria-live="polite"
            className={`${styles.status} ${status.kind === "success" ? styles.statusSuccess : styles.statusError}`}
          >
            {status.msg}
          </div>
        )}

        {/* Header inputs */}
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
            <select className={styles.select} value={selectValue} onChange={onChangeSelection} disabled={saving}>
              {agents.length > 0 && (
                <optgroup label="Agents">
                  {agents.map((a) => (
                    <option key={a.id} value={toSelection("agent", a.id)}>
                      {a.name} {a.baseModel ? `(${a.baseModel})` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Base models">
                {availableModels.map((m) => (
                  <option key={m} value={toSelection("ollama", m)}>
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
              onClick={isEditingExisting ? onUpdate : onSave}
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
          <h2 className={styles.sectionTitle}>Tools</h2>
          <div className={styles.toolList}>
            {AGENT_TOOLS.map((name) => {
              const info = AGENT_TOOL_INFO[name];
              const unavailable = toolAvailability?.find((t) => t.name === name && !t.available);
              const checked = tools.includes(name);
              return (
                <label
                  key={name}
                  className={`${styles.toolOption} ${unavailable ? styles.toolOptionUnavailable : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => toggleTool(name, e.target.checked)}
                    // A tool that cannot be used can still be turned off
                    disabled={saving || (!!unavailable && !checked)}
                  />
                  <span className={styles.toolOptionText}>
                    <span className={styles.toolOptionLabel}>
                      <ToolStepIcon icon={info.icon} className={styles.toolOptionIcon} />
                      {info.label}
                    </span>
                    <span className={styles.toolOptionHelp}>{info.help}</span>
                    {unavailable?.reason && <span className={styles.toolOptionReason}>{unavailable.reason}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          <div className={`${styles.grid} ${tools.length === 0 ? styles.toolLimitOff : ""}`}>
            <div className={styles.optionRow}>
              <label className={styles.optionLabel} htmlFor="max-tool-calls">
                Max tool calls per reply
              </label>
              <div className={styles.optionControls}>
                <input
                  id="max-tool-calls"
                  type="range"
                  min={1}
                  max={MAX_TOOL_CALLS_LIMIT}
                  step={1}
                  value={maxToolCalls}
                  onChange={(e) => setMaxToolCalls(Number(e.target.value))}
                  disabled={saving || tools.length === 0}
                />
                <div>
                  <input
                    type="number"
                    min={1}
                    max={MAX_TOOL_CALLS_LIMIT}
                    step={1}
                    value={maxToolCalls}
                    aria-label="Max tool calls per reply"
                    onChange={(e) => {
                      // Typed values are kept within 1 to 20; a cleared box keeps the last value
                      const n = Math.round(Number(e.target.value));
                      if (e.target.value !== "" && Number.isFinite(n)) {
                        setMaxToolCalls(Math.min(MAX_TOOL_CALLS_LIMIT, Math.max(1, n)));
                      }
                    }}
                    disabled={saving || tools.length === 0}
                  />
                </div>
              </div>
              <span className={styles.toolOptionHelp}>
                After this many tool calls, the agent answers with what it has found.
              </span>
            </div>
          </div>
          {tools.length > 0 && opts.num_ctx < MIN_TOOLS_NUM_CTX && (
            <p className={styles.toolHint}>
              Web pages need room: set the context window to 16384 tokens or more, or pages get cut short.
            </p>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Generation options</h2>
          <div className={styles.grid}>
            {OPTION_FIELDS.map((field) => (
              <div key={field.key} className={styles.optionRow}>
                <label className={styles.optionLabel}>{field.label}</label>
                <div className={styles.optionControls}>
                  {renderControl(field)}
                  {field.number && (
                    <div>
                      <input
                        className={field.key === "seed" ? styles.seedNumber : undefined}
                        type="number"
                        {...field.number}
                        value={opts[field.key]}
                        onChange={(e) => setOpt(field.key, parseOptionValue(field, e.target.value, true))}
                        disabled={saving}
                      />
                    </div>
                  )}
                </div>
                {field.contextSlider && contextLength !== null && opts[field.key] > contextLength && (
                  <span className={styles.optionHint}>
                    {baseModel} supports up to {contextLength} tokens, so Ollama uses {contextLength}.
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className={styles.footerActions}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => helpDialogRef.current?.showModal()}
            disabled={saving}
          >
            Help
          </button>
          <button
            type="button"
            className={styles.resetBtn}
            onClick={() => {
              setOpts(DEFAULT_AGENT_SETTINGS);
              setStatus(null);
            }}
            disabled={saving}
          >
            Reset to defaults
          </button>
        </section>
      </div>

      <dialog ref={helpDialogRef} className={styles.helpDialog}>
        <div className={styles.helpContent}>
          <div className={styles.helpHeader}>
            <h3>Agent options</h3>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => helpDialogRef.current?.close()}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className={styles.helpBody}>
            <dl className={styles.helpList}>
              {OPTION_FIELDS.map((field) => (
                <Fragment key={field.key}>
                  <dt>{field.label}</dt>
                  <dd>{field.help}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        </div>
      </dialog>
    </AppShell>
  );
}
