"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { optionFamily, type AgentSettings, type OptionFamily, type OptionValue } from "@/lib/agentSettings";
import type { ProviderId } from "@/lib/providers";
import { parseBaseModel } from "@/lib/selection";
import type { BaseModelInfo } from "@/lib/types";
import {
  contextStops,
  currentValue,
  DEFAULT_CONTEXT_MAX,
  defaultValueOf,
  optionGroupsFor,
  parseOptionValue,
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

/**
 * The number box of an option. It shows the value, or the default while the
 * option is not set; while the user types, it shows what they typed, so that
 * clearing the box to type a new number does not bring the default back.
 */
function NumberBox({
  id,
  field,
  value,
  shown,
  onChange,
  disabled,
}: {
  id: string;
  field: OptionField;
  value: number | undefined;
  shown: number | undefined;
  onChange: (value: number | undefined) => void;
  disabled: boolean;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  // Moving the slider while the box has focus changes the value without typing
  const stillTyped = typed !== null && parseOptionValue(field, typed) === value;
  return (
    <input
      id={id}
      className={field.key === "seed" ? styles.seedNumber : undefined}
      type="number"
      {...field.number}
      placeholder={field.noDefault}
      aria-label={field.label}
      value={stillTyped ? typed : (shown ?? "")}
      onChange={(e) => {
        setTyped(e.target.value);
        onChange(parseOptionValue(field, e.target.value));
      }}
      onBlur={() => setTyped(null)}
      disabled={disabled}
    />
  );
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
  const shown = value ?? defaultValueOf(field, family, info);
  const numeric = typeof shown === "number" ? shown : undefined;
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
      // The default shows as the choice it is; only an unknown default gets its own entry
      const selected = choices.find((c) => String(c.value) === String(shown));
      return (
        <select
          id={id}
          className={styles.inlineSelect}
          value={selected ? String(selected.value) : ""}
          onChange={(e) => onChange(choices.find((c) => String(c.value) === e.target.value)?.value)}
          disabled={disabled}
        >
          {!selected && <option value="">Model default</option>}
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
      const position = numeric ?? stops[stops.length - 1];
      // A typed value between two stops shows at the lower one
      const index = Math.max(0, stops.filter((s) => s <= position).length - 1);
      return (
        <input
          id={id}
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={index}
          aria-valuetext={String(position)}
          onChange={(e) => onChange(stops[Number(e.target.value)])}
          disabled={disabled}
        />
      );
    }
    if (field.slider) {
      return (
        <input
          id={id}
          type="range"
          {...field.slider}
          value={numeric ?? field.slider.min}
          onChange={(e) => onChange(parseOptionValue(field, e.target.value))}
          disabled={disabled}
        />
      );
    }
    // Keeps numeric-only rows right-aligned
    return <div className={styles.controlPlaceholder} />;
  }

  const hasMainControl = field.slider || field.doublingSliderTo || field.choices || field.reasoningChoices || field.lines;

  const label = (
    <label className={styles.optionLabel} htmlFor={hasMainControl ? id : `${id}-number`}>
      {field.label}
    </label>
  );

  return (
    <div className={styles.optionRow}>
      {family === "ollama" ? (
        label
      ) : (
        <div className={styles.optionLabelRow}>
          {label}
          {value !== undefined && (
            <button
              type="button"
              className={styles.optionReset}
              onClick={() => onChange(undefined)}
              disabled={disabled}
              aria-label={`Set ${field.label} back to its default`}
            >
              Default
            </button>
          )}
        </div>
      )}
      <div className={styles.optionControls}>
        {renderControl()}
        {field.number && (
          <div>
            <NumberBox
              id={`${id}-number`}
              field={field}
              value={typeof value === "number" ? value : undefined}
              shown={numeric}
              onChange={onChange}
              disabled={disabled}
            />
          </div>
        )}
      </div>
      {limit !== null && typeof value === "number" && value > limit && field.limitHint && (
        <span className={styles.optionHint}>{field.limitHint(model, limit)}</span>
      )}
    </div>
  );
}

const DEFAULTS_HELP =
  "The values you see at first are the defaults: the model's own where the provider says, otherwise the API's usual " +
  "ones. An option you do not change is not sent, so the model's real default always applies.";

const PROVIDER_HELP: Record<ProviderId, (model: string) => string> = {
  ollama: () =>
    "Ollama takes the same options for every model, so all of them are listed. It does not say which ones a " +
    "model's engine ignores, so an option can have no effect on some models. The values you see are what the " +
    "agent sends; they replace the model's own defaults.",
  openai: (model) =>
    `Only the options ${model} takes are listed, so the list changes with the model. OpenAI does not publish this ` +
    "per model: it comes from OpenRouter's public list of models. If OpenAI still refuses an option, the agent " +
    `leaves it out and carries on. ${DEFAULTS_HELP}`,
  openrouter: (model) =>
    `Only the options OpenRouter reports for ${model} are listed, so the list changes with the model. ${DEFAULTS_HELP}`,
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
            <section key={group.title ?? "options"}>
              {group.title ? <h4 className={styles.helpGroup}>{group.title}</h4> : <div className={styles.helpGap} />}
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
 * The generation options, behind a button that opens them, with a separate help
 * button beside it. The options depend on the model. When it changes, the previous
 * model's options stay in place, dimmed, until the new ones arrive and fade in, and
 * the panel eases to its new height. A spinner on the button shows this also while
 * the panel is closed.
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
  const settings = values[family];

  // The basics only: the request failed, or the provider does not know the model
  const basicsOnly = !loading && family === "api" && !info?.options;
  const noOptions = !loading && groups.length === 0;

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
          {loading && <span className={styles.spinner} role="status" aria-label={`Loading options for ${model}`} />}
        </button>
        <button type="button" className={styles.secondaryBtn} onClick={() => helpRef.current?.showModal()}>
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
                <div key={group.title ?? "options"} className={styles.optionGroup}>
                  {group.title && <h3 className={styles.optionGroupTitle}>{group.title}</h3>}
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
