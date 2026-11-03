"use client";

import { useState } from "react";
import styles from "../Account.module.css";
import StatusLine, { type Status } from "./StatusLine";
import { notifyProvidersChanged } from "@/hooks/useModelCatalog";
import { PROVIDER_LABELS, type KeyProviderId, type ProviderId, type ProviderSettings } from "@/lib/providers";

const KEY_PAGES: Record<KeyProviderId, { url: string; text: string }> = {
  openai: { url: "https://platform.openai.com/api-keys", text: "platform.openai.com/api-keys" },
  openrouter: { url: "https://openrouter.ai/settings/keys", text: "openrouter.ai/settings/keys" },
};

// Saves (PUT) or removes (DELETE) a provider setting. Returns the updated
// settings, or throws with the server's message.
async function updateProvider(provider: ProviderId, method: "PUT" | "DELETE", body?: object) {
  const res = await fetch(`/api/providers/${provider}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.settings) throw new Error(data?.message || `Request failed (${res.status})`);
  return data.settings as ProviderSettings;
}

// Lists the provider's models, to check that the saved address or key works.
async function checkProvider(provider: ProviderId, done: string): Promise<Status> {
  try {
    const res = await fetch(`/api/providers/${provider}/models`);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message || `status ${res.status}`);
    const count = Array.isArray(data?.models) ? data.models.length : 0;
    return { kind: "success", msg: `${done} ${count} model${count === 1 ? "" : "s"} available.` };
  } catch (err) {
    return { kind: "warning", msg: `${done} Loading the model list failed: ${(err as Error).message}` };
  }
}

/** Runs a settings change with a busy flag and a status line. */
function useProviderAction(onSaved: (settings: ProviderSettings) => void) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  async function run(change: () => Promise<ProviderSettings>, report: () => Promise<Status> | Status) {
    setBusy(true);
    setStatus(null);
    try {
      onSaved(await change());
      setStatus(await report());
      return true;
    } catch (err) {
      setStatus({ kind: "error", msg: (err as Error).message || "Request failed" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, status, run };
}

export default function ProvidersCard({ initialSettings }: { initialSettings: ProviderSettings }) {
  const [settings, setSettings] = useState(initialSettings);

  function onSaved(next: ProviderSettings) {
    setSettings(next);
    notifyProvidersChanged(); // the sidebar's model picker reloads its lists
  }

  return (
    <section className={styles.card} aria-labelledby="providers-title">
      <h2 id="providers-title" className={styles.sectionTitle}>
        Model providers
      </h2>
      <p className={styles.help}>
        Connect the providers whose models you want to chat with. API keys are stored encrypted and are not shown
        again after saving.
      </p>
      <OllamaSetting settings={settings.ollama} onSaved={onSaved} />
      <ApiKeySetting provider="openai" keyHint={settings.openai.keyHint} onSaved={onSaved} />
      <ApiKeySetting provider="openrouter" keyHint={settings.openrouter.keyHint} onSaved={onSaved} />
    </section>
  );
}

function OllamaSetting({
  settings,
  onSaved,
}: {
  settings: ProviderSettings["ollama"];
  onSaved: (settings: ProviderSettings) => void;
}) {
  const [address, setAddress] = useState(settings.custom ? settings.baseUrl : "");
  const { busy, status, run } = useProviderAction((next) => {
    onSaved(next);
    setAddress(next.ollama.custom ? next.ollama.baseUrl : "");
  });

  function save(e: React.FormEvent) {
    e.preventDefault();
    run(
      () => updateProvider("ollama", "PUT", { baseUrl: address }),
      () => checkProvider("ollama", "Saved.")
    );
  }

  function resetToDefault() {
    run(
      () => updateProvider("ollama", "DELETE"),
      () => checkProvider("ollama", "Using the default server.")
    );
  }

  return (
    <div className={styles.provider}>
      <div className={styles.providerHeader}>
        <h3 className={styles.providerName}>{PROVIDER_LABELS.ollama}</h3>
        <span className={`${styles.badge} ${settings.custom ? styles.badgeOn : ""}`}>
          {settings.custom ? "Own server" : "Default server"}
        </span>
      </div>
      <p className={styles.help}>
        Address of your Ollama server, for example <code>192.168.1.20</code> or <code>http://localhost:11434</code>.
        {!settings.custom && <> Now using the default, {settings.baseUrl}.</>}
      </p>
      <form className={styles.inlineForm} onSubmit={save}>
        <input
          className={styles.input}
          type="text"
          inputMode="url"
          aria-label="Ollama server address"
          placeholder={settings.baseUrl}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <button type="submit" className={styles.primaryBtn} disabled={busy || !address.trim()}>
          Save
        </button>
        {settings.custom && (
          <button type="button" className={styles.secondaryBtn} onClick={resetToDefault} disabled={busy}>
            Use default
          </button>
        )}
      </form>
      <StatusLine status={status} />
    </div>
  );
}

function ApiKeySetting({
  provider,
  keyHint,
  onSaved,
}: {
  provider: KeyProviderId;
  keyHint: string | null;
  onSaved: (settings: ProviderSettings) => void;
}) {
  const label = PROVIDER_LABELS[provider];
  const keyPage = KEY_PAGES[provider];
  const [apiKey, setApiKey] = useState("");
  const { busy, status, run } = useProviderAction(onSaved);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const saved = await run(
      () => updateProvider(provider, "PUT", { apiKey }),
      () => checkProvider(provider, "Key saved.")
    );
    if (saved) setApiKey("");
  }

  function remove() {
    if (!window.confirm(`Remove your ${label} API key? Its models will no longer be available.`)) return;
    run(
      () => updateProvider(provider, "DELETE"),
      () => ({ kind: "success", msg: "Key removed." })
    );
  }

  return (
    <div className={styles.provider}>
      <div className={styles.providerHeader}>
        <h3 className={styles.providerName}>{label}</h3>
        <span className={`${styles.badge} ${keyHint ? styles.badgeOn : ""}`}>
          {keyHint ? `Key saved (${keyHint})` : "No key"}
        </span>
      </div>
      <p className={styles.help}>
        Create a key at{" "}
        <a href={keyPage.url} target="_blank" rel="noreferrer">
          {keyPage.text}
        </a>
        .
      </p>
      <form className={styles.inlineForm} onSubmit={save}>
        <input
          className={styles.input}
          type="password"
          aria-label={`${label} API key`}
          placeholder={keyHint ? "Paste a new key to replace it" : "Paste your API key"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <button type="submit" className={styles.primaryBtn} disabled={busy || !apiKey.trim()}>
          Save
        </button>
        {keyHint && (
          <button type="button" className={styles.secondaryBtn} onClick={remove} disabled={busy}>
            Remove
          </button>
        )}
      </form>
      <StatusLine status={status} />
    </div>
  );
}
