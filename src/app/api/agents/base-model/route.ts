import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { getOllamaModelInfo } from "@/server/chat/models";
import { getOllamaUrl } from "@/server/providers";
import { jsonError } from "@/server/http";
import { toolAvailability } from "@/server/tools/policy";
import { parseSelection } from "@/lib/selection";
import type { BaseModelInfo } from "@/lib/types";

// GET /api/agents/base-model?model=<base model> -> BaseModelInfo
// What an agent on this Ollama model can have: the agent tools it can use (a
// tool is not available when its server is not set up, or the model cannot use
// it), and the longest context window the model supports.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const model = parseSelection(req.nextUrl.searchParams.get("model")?.trim() || null).value;
  if (!model) return jsonError("model is required", 400);

  const info = await getOllamaModelInfo(await getOllamaUrl(user.id), model);
  const body: BaseModelInfo = {
    tools: toolAvailability(info?.capabilities ?? null),
    contextLength: info?.contextLength ?? null,
  };
  return NextResponse.json(body);
}
