"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { DEFAULT_SETTINGS, optionFamily, type AgentSettings, type OptionFamily, type OptionValue } from "@/lib/agentSettings";
import type { ProviderId } from "@/lib/providers";
import { parseBaseModel } from "@/lib/selection";
import type { BaseModelInfo } from "@/lib/types";
import {
  contextStops,
  currentValue,
  DEFAULT_CONTEXT_MAX,
  optionGroupsFor,
  parseOptionValue,
  reasoningLabel,
  reasoningOptions,
  type OptionField,
  type OptionGroup,
} from "./optionFields";
import styles from "./Agents.module.css";

/** Tracks the height of what `ref` is on, so that a wrapper can animate to it. */
function useContentHeight() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

/** One option: its label, its controls, and a way back to its default. */
function OptionRow({
  field,
  family,
  model,
  info,
  value,
  onChange,
  disabled,
}: {
  field: OptionField;
  family: OptionFamily;
  model: string;
  info: BaseModelInfo | null;
  value: OptionValue | undefined;
  onChange: (value: OptionValue | undefined) => void;
  disabled: boolean;
}) {
  const id = useId();
  const defaultValue = DEFAULT_SETTINGS[family][field.key];
  const modelDefault = info?.defaults[field.key];
  const numeric = typeof value === "number" ? value : undefined;
  const isSet = value !== undefined && value !== defaultValue;
  const limit = !field.doublingSliderTo
    ? null
    : field.doublingSliderTo === "contextLength"
      ? (info?.contextLength ?? null)
      : (info?.maxOutput ?? info?.contextLength ?? null);

  function renderControl() {
    if (field.lines) {
      return (
        <textarea
          id={id}
          className={styles.stopInput}
          rows={2}
          placeholder={field.lines.placeholder}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          disabled={disabled}
        />
      );
    }
    if (field.choices || field.reasoningChoices) {
      const choices = field.choices ?? reasoningOptions(info?.reasoning ?? null);
      const known = modelDefault !== undefined ? ` (${reasoningLabel(modelDefault)})` : "";
      return (
        <select
          id={id}
          className={styles.inlineSelect}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => {
            const choice = choices.find((c) => String(c.value) === e.target.value);
            onChange(choice?.value);
          }}
          disabled={disabled}
        >
          {defaultValue === undefined && <option value="">Model default{known}</option>}
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
    }
    if (field.doublingSliderTo) {
      const stops = contextStops(limit ?? DEFAULT_CONTEXT_MAX);
      const position = numeric ?? (typeof defaultValue === "number" ? defaultValue : stops[stops.length - 1]);
      // A typed value between two stops shows at the lower one
      const index = Math.max(0, stops.filter((s) => s <= position).length - 1);
      return (
        <input
          id={id}
          className={numeric === undefined ? styles.sliderAtDefault : undefined}
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={index}
          aria-valuetext={numeric === undefined ? "Default" : String(numeric)}
          onChange={(e) => onChange(stops[Number(e.target.value)])}
          disabled={disabled}
        />
      );
    }
    if (field.slider) {
      const { rest, ...range } = field.slider;
      const position = numeric ?? (typeof modelDefault === "number" ? modelDefault : rest);
      return (
        <input
          id={id}
          className={numeric === undefined ? styles.sliderAtDefault : undefined}
          type="range"
          {...range}
          value={position}
          aria-valuetext={numeric === undefined ? "Default" : String(numeric)}
          onChange={(e) => onChange(parseOptionValue(field, e.target.value))}
          disabled={disabled}
        />
      );
    }
    // Keeps numeric-only rows right-aligned
    return <div className={styles.controlPlaceholder} />;
  }

  const placeholder = defaultValue ?? modelDefault ?? "Default";

  return (
    <div className={styles.optionRow}>
      <div className={styles.optionLabelRow}>
        <label className={styles.optionLabel} htmlFor={field.slider || field.doublingSliderTo || field.choices || field.reasoningChoices || field.lines ? id : `${id}-number`}>
          {field.label}
        </label>
        {isSet && (
          <button
            type="button"
            className={styles.optionReset}
            onClick={() => onChange(defaultValue)}
            disabled={disabled}
            aria-label={`Set ${field.label} back to its default`}
          >
            Default
          </button>
        )}
      </div>
      <div className={styles.optionControls}>
        {renderControl()}
        {field.number && (
          <div>
            <input
              id={`${id}-number`}
              className={field.key === "seed" ? styles.seedNumber : undefined}
              type="number"
              {...field.number}
              placeholder={String(placeholder)}
              aria-label={field.label}
              value={numeric ?? ""}
              onChange={(e) => onChange(parseOptionValue(field, e.target.value))}
              disabled={disabled}
            />
          </div>
        )}
      </div>
      {limit !== null && numeric !== undefined && numeric > limit && field.limitHint && (
        <span className={styles.optionHint}>{field.limitHint(model, limit)}</span>
      )}
    </div>
  );
}

const PROVIDER_HELP: Record<ProviderId, (model: string) => string> = {
  ollama: () =>
    "Ollama takes the same options for every model, so all of them are listed. It does not say which ones a " +
    "model's engine ignores, so an option can have no effect on some models. The values you see are what the " +
    "agent sends; they replace the model's own defaults.",
  openai: (model) =>
    `Only the options ${model} takes are listed, so the list changes with the model. OpenAI does not publish this ` +
    "per model: it comes from OpenRouter's public list of models. If OpenAI still refuses an option, the agent " +
    "leaves it out and carries on. An option on Default uses the model's own setting.",
  openrouter: (model) =>
    `Only the options OpenRouter reports for ${model} are listed, so the list changes with the model. An option on ` +
    "Default uses the model's own setting, and OpenRouter sends no value for it.",
};

/** The help dialog: what the options listed for this model do, and what else depends on the model. */
function OptionsHelp({
  dialogRef,
  provider,
  model,
  groups,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  provider: ProviderId;
  model: string;
  groups: OptionGroup[];
}) {
  return (
    <dialog ref={dialogRef} className={styles.helpDialog} aria-labelledby="agent-help-title">
      <div className={styles.helpContent}>
        <div className={styles.helpHeader}>
          <h3 id="agent-help-title">Agent options</h3>
          <button type="button" className={styles.closeBtn} onClick={() => dialogRef.current?.close()} aria-label="Close">
            ×
          </button>
        </div>
        <div className={styles.helpBody}>
          <p className={styles.helpText}>{PROVIDER_HELP[provider](model)}</p>
          {groups.map((group) => (
            <section key={group.title}>
              <h4 className={styles.helpGroup}>{group.title}</h4>
              {group.note && <p className={styles.helpText}>{group.note}</p>}
              <dl className={styles.helpList}>
                {group.fields.map((field) => (
                  <Fragment key={field.key}>
                    <dt>{field.label}</dt>
                    <dd>{field.help}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
          <section>
            <h4 className={styles.helpGroup}>Tools</h4>
            <p className={styles.helpText}>
              A tool can only be checked when the model can use it. Screenshots also need a model that can see images.
              {provider !== "ollama" && " Web pages the agent reads are sent to the provider, like the rest of the chat."}
            </p>
          </section>
          <section>
            <h4 className={styles.helpGroup}>When a model goes away</h4>
            <p className={styles.helpText}>
              {provider === "ollama"
                ? "If a model is removed from your Ollama server, or the server cannot be reached, the agent is greyed out in the model list on the chat page."
                : "Providers retire models. Where the date is known, the model list shows it. Once the model is gone, the agent is greyed out in the model list on the chat page."}{" "}
              Nothing of the agent is lost: pick another base model here and update it.
            </p>
          </section>
        </div>
      </div>
    </dialog>
  );
}

/**
 * The generation options, behind a bar that opens them. The options depend on
 * the model. When it changes, the previous model's options stay in place, dimmed,
 * until the new ones arrive and fade in. The bar says what is going on, also while
 * the panel is closed, and the panel eases to its new height.
 */
export default function OptionsPanel({
  provider,
  model,
  shown,
  loading,
  values,
  onChange,
  onReset,
  disabled,
}: {
  provider: ProviderId;
  model: string;
  shown: { model: string; info: BaseModelInfo | null } | null;
  loading: boolean;
  values: Record<OptionFamily, AgentSettings>;
  onChange: (family: OptionFamily, key: string, value: OptionValue | undefined) => void;
  onReset: (family: OptionFamily) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [contentRef, contentHeight] = useContentHeight();
  const helpRef = useRef<HTMLDialogElement | null>(null);
  const panelId = useId();

  // What is on screen: the previous model's options while the new ones load
  const shownBase = parseBaseModel(shown?.model);
  const shownProvider = shownBase?.provider ?? provider;
  const family = optionFamily(shownProvider);
  const info = shown?.info ?? null;
  const groups = shown ? optionGroupsFor(family, info) : [];
  const fields = groups.flatMap((group) => group.fields);
  const settings = values[family];
  const changed = fields.filter((f) => {
    const value = currentValue(f, settings, info);
    return value !== undefined && value !== DEFAULT_SETTINGS[family][f.key];
  });

  // The basics only: the request failed, or the provider does not know the model
  const basicsOnly = !loading && family === "api" && !info?.options;
  const noOptions = !loading && fields.length === 0;

  let summary: string;
  if (loading) {
    summary = `Loading options for ${model}…`;
  } else if (noOptions) {
    summary = "None for this model";
  } else {
    const count = `${fields.length} ${fields.length === 1 ? "option" : "options"}`;
    const state = changed.length > 0 ? `${changed.length} ${family === "api" ? "set" : "changed"}` : family === "api" ? "all on default" : null;
    summary = state ? `${count}, ${state}` : count;
  }

  return (
    <section className={styles.optionsSection}>
      <div className={styles.optionsBar}>
        <button
          type="button"
          className={styles.optionsToggle}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          <svg
            className={`${styles.optionsChevron} ${open ? styles.optionsChevronOpen : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span className={styles.optionsTitle}>Generation options</span>
          <span className={styles.optionsSummary} aria-live="polite">
            {loading && <span className={styles.spinner} aria-hidden="true" />}
            <span className={styles.optionsSummaryText}>{summary}</span>
          </span>
        </button>
        <button
          type="button"
          className={styles.optionsHelpBtn}
          onClick={() => helpRef.current?.showModal()}
          aria-label="Help with these options"
        >
          Help
        </button>
      </div>

      <div id={panelId} className={styles.optionsCollapse} style={{ height: open ? contentHeight : 0 }} inert={!open}>
        <div ref={contentRef} className={styles.optionsContent}>
          {/* Sits over the options without taking room */}
          {loading && (
            <div className={styles.optionsLoading}>
              <span className={styles.optionsLoadingPill}>
                <span className={styles.spinner} aria-hidden="true" />
                Loading options for {model}…
              </span>
            </div>
          )}
          <div
            className={`${styles.optionsBody} ${loading ? styles.optionsBodyLoading : ""}`}
            inert={loading}
            aria-busy={loading}
          >
            <div key={shown?.model ?? "none"} className={styles.optionsFadeIn}>
              {basicsOnly && (
                <p className={styles.optionsNote}>
                  It is not known which options {model} takes, because it is not in OpenRouter&apos;s public list of models
                  or that list could not be loaded. Only the basics are shown.
                </p>
              )}
              {noOptions && <p className={styles.optionsNote}>{model} has no options that can be set.</p>}
              {groups.map((group) => (
                <div key={group.title} className={styles.optionGroup}>
                  <h3 className={styles.optionGroupTitle}>{group.title}</h3>
                  {group.note && <p className={styles.optionGroupNote}>{group.note}</p>}
                  <div className={styles.grid}>
                    {group.fields.map((field) => (
                      <OptionRow
                        key={field.key}
                        field={field}
                        family={family}
                        model={shownBase?.model ?? model}
                        info={info}
                        value={currentValue(field, settings, info)}
                        onChange={(value) => onChange(family, field.key, value)}
                        disabled={disabled}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.optionsFooter}>
            <button type="button" className={styles.resetBtn} onClick={() => onReset(family)} disabled={disabled || loading}>
              Reset to defaults
            </button>
          </div>
        </div>
      </div>

      <OptionsHelp dialogRef={helpRef} provider={shownProvider} model={shownBase?.model ?? model} groups={groups} />
    </section>
  );
}
