import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { getOllamaUrl } from "@/server/providers";
import { jsonError } from "@/server/http";
import { toolAvailability } from "@/server/tools/policy";
import { parseSelection } from "@/lib/selection";

// GET /api/tools?model=<base model> -> { tools: ToolAvailability[] }
// Which agent tools an agent on this Ollama model could use: a tool is not
// available when its server is not set up, or the model cannot use it.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const model = parseSelection(req.nextUrl.searchParams.get("model")?.trim() || null).value;
  if (!model) return jsonError("model is required", 400);

  const tools = await toolAvailability(await getOllamaUrl(user.id), model);
  return NextResponse.json({ tools });
}
