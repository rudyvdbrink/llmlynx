"use client";

import styles from "./Sidebar.module.css";

export default function ModelSection({
  model,
  onChangeModel,
  disabled,
}: {
  model: string;
  onChangeModel: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.modelBlock}>
      <p className={styles.sidebarTitle} id="model-select-label">
        Model
      </p>
      <select
        aria-labelledby="model-select-label"
        className={styles.modelSelect}
        value={model}
        onChange={(e) => onChangeModel(e.target.value)}
        disabled={disabled}
      >
        <option value="gpt-oss:20b">gpt-oss:20b</option>
        <option value="gemma3:1b">gemma3:1b</option>
        <option value="gemma3:12b">gemma3:12b</option>
        <option value="llama3.2:3b">llama3.2:3b</option>
        <option value="mistral">mistral</option>
      </select>
    </div>
  );
}