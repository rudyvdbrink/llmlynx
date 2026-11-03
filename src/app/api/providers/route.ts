import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { getProviderSettings } from "@/server/providers";
import { jsonError } from "@/server/http";

// GET /api/providers -> the current user's provider settings (keys are never returned)
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  return NextResponse.json(
    { settings: await getProviderSettings(user.id) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
