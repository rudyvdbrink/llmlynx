import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import {
  apiKeyError,
  getProviderSettings,
  normalizeOllamaUrl,
  removeProviderSetting,
  saveApiKey,
  saveOllamaUrl,
} from "@/server/providers";
import { SecretsKeyError } from "@/server/secrets";
import { jsonError, optionalString, readJsonObject } from "@/server/http";
import { isProviderId } from "@/lib/providers";

type Ctx = { params: Promise<{ provider: string }> };

// PUT /api/providers/:provider -> save the user's Ollama address or API key
// body: { baseUrl: string } for ollama, { apiKey: string } for openai and openrouter
// Responds with the updated settings.
export async function PUT(req: Request, ctx: Ctx) {
  const { provider } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  if (!isProviderId(provider)) return jsonError("Unknown provider", 404);

  const body = await readJsonObject(req);

  if (provider === "ollama") {
    const baseUrl = normalizeOllamaUrl(optionalString(body.baseUrl) ?? "");
    if (!baseUrl) return jsonError("Enter a server address such as 192.168.1.20 or http://localhost:11434", 400);
    await saveOllamaUrl(user.id, baseUrl);
  } else {
    const apiKey = (optionalString(body.apiKey) ?? "").trim();
    const keyError = apiKeyError(apiKey);
    if (keyError) return jsonError(keyError, 400);
    try {
      await saveApiKey(user.id, provider, apiKey);
    } catch (err) {
      if (err instanceof SecretsKeyError) return jsonError(`The server cannot store API keys: ${err.message}`, 500);
      return jsonError("Failed to save API key", 500);
    }
  }

  return NextResponse.json({ settings: await getProviderSettings(user.id) });
}

// DELETE /api/providers/:provider -> remove the user's API key, or reset Ollama to the default server
export async function DELETE(_req: Request, ctx: Ctx) {
  const { provider } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  if (!isProviderId(provider)) return jsonError("Unknown provider", 404);

  await removeProviderSetting(user.id, provider);
  return NextResponse.json({ settings: await getProviderSettings(user.id) });
}
