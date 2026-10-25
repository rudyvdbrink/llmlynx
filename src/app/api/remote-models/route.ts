import { NextResponse } from "next/server";
import { getOpenAIConfig } from "@/server/config";

export const runtime = "nodejs";

// For now, expose only GPT-5 when API_KEY is configured.
// We keep this endpoint minimal and do not call out to OpenAI here.
export async function GET() {
  const available = getOpenAIConfig() !== null;
  return NextResponse.json(
    { available, models: available ? ["gpt-5"] : [] },
    { headers: { "Cache-Control": "no-store" } }
  );
}
