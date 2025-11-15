export const runtime = "nodejs";

import { NextResponse } from "next/server";

// For now, expose only GPT-5 when API_KEY is configured.
// We keep this endpoint minimal and do not call out to OpenAI here.
export async function GET() {
  const hasKey = !!process.env.API_KEY && String(process.env.API_KEY).trim().length > 0;
  if (!hasKey) {
    return NextResponse.json({ available: false, models: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    { available: true, models: ["gpt-5"] },
    { headers: { "Cache-Control": "no-store" } }
  );
}