import { NextResponse } from "next/server";
import { OLLAMA_URL } from "@/server/config";

export const runtime = "nodejs";

// Fail fast when the Ollama host is unreachable so the UI can fall back.
const TIMEOUT_MS = 5000;

// Shape of one entry in Ollama's GET /api/tags response.
type OllamaTag = {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
};

// GET /api/models -> proxy to OLLAMA_URL/api/tags and normalize shape
export async function GET() {
  try {
    const upstream = await fetch(`${OLLAMA_URL}/api/tags`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!upstream.ok) {
      const err = await upstream.text().catch(() => "");
      return NextResponse.json(
        { message: "Failed to load models from Ollama", upstreamStatus: upstream.status, error: err || undefined },
        { status: 502 }
      );
    }

    const raw: unknown = await upstream.json().catch(() => ({}));
    const list: OllamaTag[] = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { models?: unknown })?.models)
        ? (raw as { models: OllamaTag[] }).models
        : [];

    const models = list
      .map((m) => ({
        name: m?.name || m?.model || "",
        modifiedAt: m?.modified_at ?? null,
        size: typeof m?.size === "number" ? m.size : null,
        digest: m?.digest ?? null,
        family: m?.details?.family ?? null,
        families: m?.details?.families ?? null,
        parameterSize: m?.details?.parameter_size ?? null,
        // Ollama names this field quantization_level; the old key never matched.
        quantization: m?.details?.quantization_level ?? null,
      }))
      .filter((m) => m.name);

    return NextResponse.json({ models }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { message: "Error contacting Ollama", error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
