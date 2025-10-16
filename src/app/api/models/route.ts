export const runtime = "nodejs";

import { NextResponse } from "next/server";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// GET /api/models -> proxy to OLLAMA_URL/api/tags and normalize shape
export async function GET(_req: Request) {
  try {
    const upstream = await fetch(`${OLLAMA_URL}/api/tags`, {
      method: "GET",
      // Prevent caching since local model availability can change
      headers: { "Accept": "application/json" },
    });

    if (!upstream.ok) {
      let err = "";
      try { err = await upstream.text(); } catch {}
      return NextResponse.json(
        { message: "Failed to load models from Ollama", upstreamStatus: upstream.status, error: err || undefined },
        { status: 502 }
      );
    }

    const raw = await upstream.json().catch(() => ({} as any));
    // Ollama returns: { models: [ { name, model, modified_at, size, digest, details: {...} } ] }
    const list: any[] = Array.isArray(raw?.models) ? raw.models : Array.isArray(raw) ? raw : [];

    const models = list
      .map((m) => {
        const name = m?.name || m?.model || "";
        return {
          name,
          modifiedAt: m?.modified_at ?? null,
          size: typeof m?.size === "number" ? m.size : null,
          digest: m?.digest ?? null,
          family: m?.details?.family ?? null,
          families: m?.details?.families ?? null,
          parameterSize: m?.details?.parameter_size ?? null,
          quantization: m?.details?.quantization ?? null,
          // Keep original object for debugging if needed in future:
          // raw: m,
        };
      })
      .filter((m) => m.name);

    return NextResponse.json(
      { models },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { message: "Error contacting Ollama", error: e?.message || String(e) },
      { status: 500 }
    );
  }
}