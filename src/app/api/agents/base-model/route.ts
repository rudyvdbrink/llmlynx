import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { getModelInfo } from "@/server/chat/models";
import { jsonError } from "@/server/http";
import { toolAvailability } from "@/server/tools/policy";
import { parseBaseModel } from "@/lib/selection";
import type { BaseModelInfo } from "@/lib/types";

// GET /api/agents/base-model?model=<selection or Ollama model name> -> BaseModelInfo
// What an agent on this model can have: the agent tools it can use (a tool is
// not available when its server is not set up, or the model cannot use it), the
// generation options it takes, and its limits.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const base = parseBaseModel(req.nextUrl.searchParams.get("model")?.trim() || null);
  if (!base) return jsonError("model is required", 400);

  const info = await getModelInfo(user.id, base.provider, base.model);
  const body: BaseModelInfo = {
    tools: toolAvailability(info.capabilities),
    contextLength: info.contextLength,
    maxOutput: info.maxOutput,
    options: info.options,
    reasoning: info.reasoning,
    defaults: info.defaults,
  };
  return NextResponse.json(body);
}
