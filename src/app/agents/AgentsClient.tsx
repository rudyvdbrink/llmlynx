"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import { CheckIcon } from "@/components/icons";
import ModelPicker, { type PickerItem } from "@/components/sidebar/ModelPicker";
import sidebarStyles from "@/components/sidebar/Sidebar.module.css";
import { useConversationList } from "@/hooks/useConversationList";
import { useLastChatHref } from "@/hooks/useLastChat";
import {
  notifyAgentsChanged,
  useAgentList,
  useAgentStatuses,
  useProviderModels,
  useProviderSettings,
} from "@/hooks/useModelCatalog";
import {
  DEFAULT_SETTINGS,
  defaultContextWindow,
  optionFamily,
  type AgentSettings,
  type OptionFamily,
  type OptionValue,
} from "@/lib/agentSettings";
import {
  AGENT_TOOL_INFO,
  AGENT_TOOLS,
  DEFAULT_MAX_TOOL_CALLS,
  contextWindowHint,
  MAX_TOOL_CALLS_LIMIT,
  TOOL_REQUIRES,
  validateAgentTools,
  validateMaxToolCalls,
  type AgentToolName,
} from "@/lib/agentTools";
import { DEFAULT_MODELS, hasModel, isProviderReady, PROVIDER_LABELS, PROVIDERS, type ProviderId } from "@/lib/providers";
import { DEFAULT_SELECTION, parseBaseModel, toSelection } from "@/lib/selection";
import type { AgentSummary, SessionUser } from "@/lib/types";
import chatStyles from "../chat/Chat.module.css";
import styles from "./Agents.module.css";
import OptionsPanel from "./OptionsPanel";
import { useBaseModelInfo } from "./useBaseModelInfo";
import { ToolStepIcon } from "../chat/components/ToolLine";

// In the base model list, entries for agents are selections of agents, so they
// cannot be mistaken for a model. This one starts a new agent.
const NEW_AGENT = toSelection("agent", "new");
const AGENT_PREFIX = toSelection("agent", "");


// How long the check mark stays after saving
const SAVED_MS = 1500;

// Each kind of provider keeps its own values, so trying another provider loses nothing
const newOptions = (): Record<OptionFamily, AgentSettings> => ({ ollama: DEFAULT_SETTINGS.ollama, api: DEFAULT_SETTINGS.api });

export default function AgentsClient({
  initialUser,
  initialSelection,
}: {
  initialUser: SessionUser;
  initialSelection: string | null;
}) {
  const router = useRouter();

  // Sidebar state (auth ensured by server)
  const conversationList = useConversationList();
  const lastChatHref = useLastChatHref();
  const [sidebarSelection, setSidebarSelection] = useState(initialSelection ?? DEFAULT_SELECTION);
  const goToChat = () => router.push("/chat");
  const openInChat = (id: string) => router.push(`/chat?conversation=${encodeURIComponent(id)}`);

  // Agent form state (UI)
  const [agents] = useAgentList();
  const { statuses } = useAgentStatuses();
  const providerSettings = useProviderSettings();
  // Set while editing a saved agent; null while creating a new one.
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [provider, setProvider] = useState<ProviderId>("ollama");
  const [modelPick, setModelPick] = useState(DEFAULT_MODELS.ollama);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [opts, setOpts] = useState(newOptions);
  // Tools are off until the user checks them
  const [tools, setTools] = useState<AgentToolName[]>([]);
  // Says so when the context window is small for the agent's tools
  const windowHint = provider === "ollama" ? contextWindowHint(tools, Number(opts.ollama.num_ctx ?? 0)) : null;
  const [maxToolCalls, setMaxToolCalls] = useState(DEFAULT_MAX_TOOL_CALLS);
  // Whether the Ollama context window is the base model's default (half of what it supports), which
  // follows the model when it changes, or a value the user set
  const [numCtxAuto, setNumCtxAuto] = useState(true);
  // A saved agent that was just opened: whether its context window is its model's default is known
  // once what that model supports is in
  const [loadedNumCtx, setLoadedNumCtx] = useState<{ selection: string; value: unknown } | null>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The model last picked per provider, so switching back restores it
  const lastModelRef = useRef<Partial<Record<ProviderId, string>>>({});

  const { models, expiries, loading: modelsLoading, error: modelsError } = useProviderModels(provider);

  // The default model may not be on offer; for a new agent, fall back to the first one that is.
  const baseModel = !agentId && models.length > 0 && !hasModel(provider, models, modelPick) ? models[0] : modelPick;
  const selection = toSelection(provider, baseModel);

  const { shown: shownInfo, loading: infoLoading, info } = useBaseModelInfo(selection);
  const toolAvailability = shownInfo?.info?.tools ?? null;
  const family = optionFamily(provider);

  const providerLabel = PROVIDER_LABELS[provider];
  const modelGone = !!agentId && !modelsLoading && !modelsError && !hasModel(provider, models, baseModel);
  const expiresOn = expiries[baseModel];
  const modelNotice = modelsError
    ? models.length > 0
      ? `${modelsError}. Showing common models.`
      : modelsError
    : modelGone
      ? `${baseModel} ${provider === "ollama" ? "is not on your Ollama server" : `is no longer available on ${providerLabel}`}. Pick another model; the rest of this agent stays as it is.`
      : expiresOn
        ? `${providerLabel} retires ${baseModel} on ${expiresOn}. Pick another model before then to keep this agent working.`
        : null;

  // The context window follows the base model while the user has not set it
  const numCtx = opts.ollama.num_ctx;
  useEffect(() => {
    if (family !== "ollama" || infoLoading) return;
    const fallback = defaultContextWindow(info?.contextLength);
    if (loadedNumCtx) {
      if (loadedNumCtx.selection !== selection) return;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- known only once the model's info is in
      setLoadedNumCtx(null);
      setNumCtxAuto(loadedNumCtx.value === fallback);
      return;
    }
    if (numCtxAuto && numCtx !== fallback) setOpts((prev) => ({ ...prev, ollama: { ...prev.ollama, num_ctx: fallback } }));
  }, [family, infoLoading, info, selection, loadedNumCtx, numCtxAuto, numCtx]);

  // The check mark after saving goes away by itself
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  // A tool that only works together with another goes off with it
  function toggleTool(name: AgentToolName, on: boolean) {
    setTools((prev) => {
      const next = AGENT_TOOLS.filter((t) => (t === name ? on : prev.includes(t)));
      return next.filter((t) => !TOOL_REQUIRES[t] || next.includes(TOOL_REQUIRES[t]));
    });
  }

  // Select all: every tool the base model can use, or none when they are all on already
  const usableTools = AGENT_TOOLS.filter((name) => !toolAvailability?.some((t) => t.name === name && !t.available));
  const allToolsOn = usableTools.length > 0 && usableTools.every((name) => tools.includes(name));

  function setOpt(optionsFamily: OptionFamily, key: string, value: OptionValue | undefined) {
    if (optionsFamily === "ollama" && key === "num_ctx") setNumCtxAuto(false);
    setOpts((prev) => {
      const next = { ...prev[optionsFamily] };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return { ...prev, [optionsFamily]: next };
    });
  }

  function changeProvider(next: ProviderId) {
    lastModelRef.current[provider] = baseModel;
    setProvider(next);
    setModelPick(lastModelRef.current[next] ?? DEFAULT_MODELS[next]);
  }

  // Keeps the provider and model: only what makes up the agent is cleared
  function startNewAgent() {
    setAgentId(null);
    setAgentName("");
    setSystemPrompt("");
    setOpts(newOptions());
    setNumCtxAuto(true);
    setLoadedNumCtx(null);
    setTools([]);
    setMaxToolCalls(DEFAULT_MAX_TOOL_CALLS);
  }

  async function loadAgent(id: string) {
    try {
      const res = await fetch(`/api/agents/${id}`);
      if (!res.ok) throw new Error("Failed to load agent");
      const data = await res.json();
      const a = data?.agent;
      const base = parseBaseModel(a?.baseModel);
      if (!a || !base) throw new Error("Invalid agent payload");
      const savedFamily = optionFamily(base.provider);
      setAgentId(id);
      setAgentName(a.name ?? "");
      setProvider(base.provider);
      setModelPick(base.model);
      setSystemPrompt(a.systemPrompt ?? "");
      setOpts({
        ...newOptions(),
        [savedFamily]: { ...DEFAULT_SETTINGS[savedFamily], ...(a.settings as AgentSettings) },
      });
      // A saved agent keeps its context window; it follows a new base model only when it is its model's default
      setNumCtxAuto(false);
      setLoadedNumCtx(
        savedFamily === "ollama" ? { selection: toSelection(base.provider, base.model), value: (a.settings as AgentSettings)?.num_ctx } : null
      );
      const savedTools = validateAgentTools(a.tools);
      setTools(savedTools.ok ? savedTools.value : []);
      const savedMax = validateMaxToolCalls(a.maxToolCalls);
      setMaxToolCalls(savedMax.ok ? savedMax.value : DEFAULT_MAX_TOOL_CALLS);
    } catch (err) {
      setError((err as Error)?.message || "Failed to load agent");
    }
  }

  function onPickBaseModel(value: string) {
    setError(null);
    if (value === NEW_AGENT) startNewAgent();
    else if (value.startsWith(AGENT_PREFIX)) loadAgent(value.slice(AGENT_PREFIX.length));
    // While editing an agent, another model is that agent's new base model
    else setModelPick(value);
  }

  const isEditingExisting = !!agentId;

  // What the model does not take is left out; while that is not known, all is kept.
  function settingsToSave(): AgentSettings {
    const settings = opts[family];
    if (family !== "api" || !info?.options) return settings;
    const { options, reasoning } = info;
    return Object.fromEntries(
      Object.entries(settings).filter(
        ([key, value]) => options.includes(key) && (key !== "reasoning" || !!reasoning?.includes(String(value)))
      )
    );
  }

  // Sends the form to the API. Returns the saved agent; throws with what went wrong.
  async function submitAgent(url: string, method: "POST" | "PATCH", failLabel: string) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: agentName.trim(),
        baseModel: selection,
        systemPrompt,
        settings: settingsToSave(),
        tools,
        maxToolCalls,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || `${failLabel} failed (${res.status})`);
    return data?.agent as AgentSummary | undefined;
  }

  async function onSave() {
    setError(null);
    setSaved(false);
    if (!agentName.trim()) {
      setError("Please enter an agent name.");
      return;
    }
    if (!baseModel.trim()) {
      setError("Please select a base model.");
      return;
    }

    setSaving(true);
    try {
      const agent = isEditingExisting
        ? await submitAgent(`/api/agents/${agentId}`, "PATCH", "Update")
        : await submitAgent("/api/agents", "POST", "Save");
      // Switch to editing the newly-created agent
      if (!isEditingExisting && agent?.id) {
        setModelPick(baseModel);
        setAgentId(agent.id);
      }
      notifyAgentsChanged();
      setSaved(true);
    } catch (e) {
      setError((e as Error)?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!agentId) return;
    setError(null);
    setSaved(false);
    const ok = window.confirm(`Delete the agent "${agentName.trim()}"? This cannot be undone. Its conversations stay.`);
    if (!ok) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agentId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      if (sidebarSelection === toSelection("agent", agentId)) setSidebarSelection(DEFAULT_SELECTION);
      startNewAgent();
      notifyAgentsChanged();
    } catch (e) {
      setError((e as Error)?.message || "Delete failed.");
    } finally {
      setSaving(false);
    }
  }

  // The provider's agents come first in the base model list; picking one opens it.
  const providerAgents = agents.filter((a) => parseBaseModel(a.baseModel)?.provider === provider);
  const modelItems: PickerItem[] = models.map((m) => ({
    value: m,
    label: m,
    detail: expiries[m] ? `until ${expiries[m]}` : undefined,
  }));
  const pickerItems: PickerItem[] =
    providerAgents.length === 0 && !isEditingExisting
      ? modelItems
      : [
          ...(isEditingExisting ? [{ value: NEW_AGENT, label: "New agent", group: "Agents" }] : []),
          ...providerAgents.map((a) => ({
            value: toSelection("agent", a.id),
            label: a.name,
            detail: statuses[a.id]?.unavailable ?? parseBaseModel(a.baseModel)?.model,
            group: "Agents",
          })),
          ...modelItems.map((item) => ({ ...item, group: "Base models" })),
        ];

  const headerSelect = `${sidebarStyles.modelSelect} ${styles.headerControl}`;

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
        footerNavHref: lastChatHref,
      }}
    >
      <div className={`${chatStyles.chatArea} ${styles.agentsArea}`}>
        {/* Header inputs */}
        <section className={styles.headerRow}>
          <div className={styles.fieldGroup}>
            <h2 className={styles.sectionTitle}>Agent name</h2>
            <input
              className={`${styles.textInput} ${styles.headerControl}`}
              type="text"
              aria-label="Agent name"
              placeholder="e.g. Research Copilot"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              disabled={saving}
            />
          </div>

          <div className={styles.fieldGroup}>
            <h2 className={styles.sectionTitle}>Provider</h2>
            <select
              className={headerSelect}
              aria-label="Provider"
              value={provider}
              onChange={(e) => changeProvider(e.target.value as ProviderId)}
              disabled={saving}
            >
              {PROVIDERS.map((p) => {
                const noKey = !!providerSettings && !isProviderReady(providerSettings, p);
                // Agents on a provider without a key must stay reachable, to fix or delete them
                const hasAgents = agents.some((a) => parseBaseModel(a.baseModel)?.provider === p);
                return (
                  <option key={p} value={p} disabled={noKey && !hasAgents && p !== provider}>
                    {PROVIDER_LABELS[p]}
                    {noKey ? " (no API key)" : ""}
                  </option>
                );
              })}
            </select>
          </div>

          <div className={styles.fieldGroup}>
            <h2 className={styles.sectionTitle}>Base model</h2>
            <ModelPicker
              label="Base model"
              items={pickerItems}
              value={baseModel}
              valueLabel={baseModel || "No model selected"}
              open={modelPickerOpen}
              onOpenChange={setModelPickerOpen}
              onPick={onPickBaseModel}
              loading={modelsLoading}
              notice={modelsError}
              noticeIsError={!!modelsError && models.length === 0}
              emptyText="No models available"
              searchPlaceholder={providerAgents.length > 0 ? "Search agents and models…" : "Search models…"}
              disabled={saving}
              triggerClassName={styles.headerControl}
              // The agents come first, out of sight above the current model otherwise
              openAtTop={!!pickerItems[0]?.group}
            />
          </div>

          <div className={styles.actionsBlock}>
            {saved && (
              <span className={styles.savedMark} role="status" aria-label={isEditingExisting ? "Agent saved" : "Saved"}>
                <CheckIcon size={18} />
              </span>
            )}
            {isEditingExisting && (
              <button
                type="button"
                className={`${styles.dangerBtn} ${styles.headerControl}`}
                onClick={onDelete}
                disabled={saving}
                title="Delete this agent"
              >
                Delete
              </button>
            )}
            <button
              type="button"
              className={`${styles.primaryBtn} ${styles.headerControl}`}
              onClick={onSave}
              disabled={saving}
              title={isEditingExisting ? "Update this agent" : "Create a new agent"}
            >
              {saving ? (isEditingExisting ? "Updating..." : "Saving...") : isEditingExisting ? "Update" : "Save agent"}
            </button>
          </div>
        </section>
        {/* Always takes room, so that a notice or an error does not move the page */}
        <p
          className={`${styles.modelNotice} ${error ? styles.modelNoticeError : ""}`}
          role={error || modelNotice ? "status" : undefined}
        >
          {error ?? modelNotice}
        </p>

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
          <div className={`${styles.toolList} ${infoLoading ? styles.toolListLoading : ""}`}>
            <label className={styles.toolOption}>
              <input
                type="checkbox"
                checked={allToolsOn}
                onChange={() => setTools(allToolsOn ? [] : usableTools)}
                disabled={saving || usableTools.length === 0}
              />
              <span className={styles.toolOptionText}>
                <span className={styles.toolOptionLabel}>Select all</span>
              </span>
            </label>
            <div className={styles.toolListSpacer} aria-hidden="true" />
            {AGENT_TOOLS.map((name) => {
              const toolInfo = AGENT_TOOL_INFO[name];
              const required = TOOL_REQUIRES[name];
              const unavailable =
                toolAvailability?.find((t) => t.name === name && !t.available) ??
                (required && !tools.includes(required) ? { reason: `Needs ${AGENT_TOOL_INFO[required].label}` } : undefined);
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
                      <ToolStepIcon icon={toolInfo.icon} className={styles.toolOptionIcon} />
                      {toolInfo.label}
                    </span>
                    {/* The reason shows in place of the help text, so that a model change does not move the page */}
                    <span className={styles.toolOptionDetail}>
                      <span className={styles.toolOptionHelp}>{toolInfo.help}</span>
                      {unavailable?.reason && <span className={styles.toolOptionReason}>{unavailable.reason}</span>}
                    </span>
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
                  min={0}
                  max={MAX_TOOL_CALLS_LIMIT}
                  step={1}
                  value={maxToolCalls}
                  onChange={(e) => setMaxToolCalls(Number(e.target.value))}
                  disabled={saving || tools.length === 0}
                />
                <div>
                  <input
                    type="number"
                    min={0}
                    max={MAX_TOOL_CALLS_LIMIT}
                    step={1}
                    value={maxToolCalls}
                    aria-label="Max tool calls per reply"
                    onChange={(e) => {
                      // Typed values are kept within the slider's range; a cleared box keeps the last value
                      const n = Math.round(Number(e.target.value));
                      if (e.target.value !== "" && Number.isFinite(n)) {
                        setMaxToolCalls(Math.min(MAX_TOOL_CALLS_LIMIT, Math.max(0, n)));
                      }
                    }}
                    disabled={saving || tools.length === 0}
                  />
                </div>
              </div>
              <span className={styles.toolOptionHelp}>
                After this many tool calls, the agent answers with what it has found. 0 means no limit.
              </span>
            </div>
          </div>
          {windowHint && <p className={styles.toolHint}>{windowHint}</p>}
        </section>

        <OptionsPanel
          provider={provider}
          model={baseModel}
          shown={shownInfo}
          loading={infoLoading}
          values={opts}
          onChange={setOpt}
          onReset={(optionsFamily) => {
            const defaults =
              optionsFamily === "ollama"
                ? { ...DEFAULT_SETTINGS.ollama, num_ctx: defaultContextWindow(info?.contextLength) }
                : DEFAULT_SETTINGS[optionsFamily];
            setOpts((prev) => ({ ...prev, [optionsFamily]: defaults }));
            if (optionsFamily === "ollama") setNumCtxAuto(true);
            setError(null);
          }}
          disabled={saving}
        />
      </div>
    </AppShell>
  );
}
