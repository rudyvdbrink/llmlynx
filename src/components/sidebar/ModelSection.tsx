"use client";

import styles from "./Sidebar.module.css";
import { useAgentList, useLocalModels, useRemoteModels } from "@/hooks/useModelCatalog";
import { normalizeSelection, parseSelection, toSelection } from "@/lib/selection";

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
  const baseModels = useLocalModels();
  const [agents] = useAgentList();
  const remoteModels = useRemoteModels();

  // Normalize incoming value to ensure the select has a matching option
  const value = normalizeSelection(model);

  // Keep the current selection visible even when it is not in any list
  // (still loading, an uninstalled model, or a deleted agent).
  const listed =
    agents.some((a) => toSelection("agent", a.id) === value) ||
    remoteModels.some((m) => toSelection("remote", m) === value) ||
    baseModels.some((m) => toSelection("model", m) === value);
  const current = parseSelection(value);

  return (
    <div className={styles.modelBlock}>
      <p className={styles.sidebarTitle} id="model-select-label">
        Model
      </p>
      <select
        aria-labelledby="model-select-label"
        className={styles.modelSelect}
        value={value}
        onChange={(e) => onChangeModel(e.target.value)}
        disabled={disabled}
      >
        {agents.length > 0 && (
          <optgroup label="Agents">
            {agents.map((a) => (
              <option key={a.id} value={toSelection("agent", a.id)}>
                {a.name} {a.baseModel ? `(${a.baseModel})` : ""}
              </option>
            ))}
          </optgroup>
        )}

        {remoteModels.length > 0 && (
          <optgroup label="Remote">
            {remoteModels.map((m) => (
              <option key={m} value={toSelection("remote", m)}>
                {m}
              </option>
            ))}
          </optgroup>
        )}

        <optgroup label="Base models">
          {baseModels.map((m) => (
            <option key={m} value={toSelection("model", m)}>
              {m}
            </option>
          ))}
        </optgroup>

        {!listed && <option value={value}>{current.kind === "agent" ? "Unknown agent" : current.value}</option>}
      </select>
    </div>
  );
}
