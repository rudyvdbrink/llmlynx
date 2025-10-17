import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";
import { getCurrentUser } from "../../../lib/session";

type AgentSettings = {
  mirostat: number;
  mirostat_eta: number;
  mirostat_tau: number;
  num_ctx: number;
  repeat_last_n: number;
  repeat_penalty: number;
  temperature: number;
  seed: number;
  num_predict: number;
  top_k: number;
  top_p: number;
  min_p: number;
};

const DEFAULT_SETTINGS: AgentSettings = {
  mirostat: 0,
  mirostat_eta: 0.1,
  mirostat_tau: 5.0,
  num_ctx: 2048,
  repeat_last_n: 64,
  repeat_penalty: 1.1,
  temperature: 0.8,
  seed: 0,
  num_predict: -1,
  top_k: 40,
  top_p: 0.9,
  min_p: 0.0,
};

function validateSettings(input: any): { ok: true; value: AgentSettings } | { ok: false; message: string } {
  const v = { ...DEFAULT_SETTINGS, ...(input ?? {}) };

  const num = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : NaN);

  v.mirostat = Math.trunc(num(v.mirostat));
  if (v.mirostat < 0 || v.mirostat > 2) return { ok: false, message: "mirostat must be 0, 1, or 2" };

  v.mirostat_eta = num(v.mirostat_eta);
  if (!(v.mirostat_eta >= 0 && v.mirostat_eta <= 1)) return { ok: false, message: "mirostat_eta must be between 0 and 1" };

  v.mirostat_tau = num(v.mirostat_tau);
  if (!(v.mirostat_tau >= 0 && v.mirostat_tau <= 10)) return { ok: false, message: "mirostat_tau must be between 0 and 10" };

  v.num_ctx = Math.trunc(num(v.num_ctx));
  if (!(v.num_ctx > 0)) return { ok: false, message: "num_ctx must be > 0" };

  v.repeat_last_n = Math.trunc(num(v.repeat_last_n));
  if (!(v.repeat_last_n >= -1)) return { ok: false, message: "repeat_last_n must be >= -1" };

  v.repeat_penalty = num(v.repeat_penalty);
  if (!(v.repeat_penalty >= 0 && v.repeat_penalty <= 3)) return { ok: false, message: "repeat_penalty must be in [0,3]" };

  v.temperature = num(v.temperature);
  if (!(v.temperature >= 0 && v.temperature <= 2)) return { ok: false, message: "temperature must be in [0,2]" };

  v.seed = Math.trunc(num(v.seed));
  // allow any 32-bit-ish range, no strict bound

  v.num_predict = Math.trunc(num(v.num_predict));
  // allow -1 for unlimited
  if (!(v.num_predict === -1 || v.num_predict >= 0)) return { ok: false, message: "num_predict must be -1 or >= 0" };

  v.top_k = Math.trunc(num(v.top_k));
  if (!(v.top_k >= 0 && v.top_k <= 10000)) return { ok: false, message: "top_k must be in [0,10000]" };

  v.top_p = num(v.top_p);
  if (!(v.top_p >= 0 && v.top_p <= 1)) return { ok: false, message: "top_p must be in [0,1]" };

  v.min_p = num(v.min_p);
  if (!(v.min_p >= 0 && v.min_p <= 1)) return { ok: false, message: "min_p must be in [0,1]" };

  return { ok: true, value: v };
}

// GET /api/agents -> list current user's agents
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const agents = await prisma.agent.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      name: true,
      baseModel: true,
      systemPrompt: true,
      updatedAt: true,
      createdAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ agents });
}

// POST /api/agents -> create a new agent
// body: { name: string, baseModel: string, systemPrompt?: string, settings?: AgentSettings }
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  const baseModel = typeof body.baseModel === "string" ? body.baseModel.trim() : "";
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : undefined;

  if (!rawName) return NextResponse.json({ message: "Name is required" }, { status: 400 });
  if (!baseModel) return NextResponse.json({ message: "Base model is required" }, { status: 400 });
  if (rawName.length > 80) return NextResponse.json({ message: "Name too long (max 80)" }, { status: 400 });

  const v = validateSettings(body.settings);
  if (!v.ok) return NextResponse.json({ message: v.message }, { status: 400 });

  try {
    const created = await prisma.agent.create({
      data: {
        userId: user.id,
        name: rawName,
        baseModel,
        systemPrompt: systemPrompt ?? null,
        settings: v.value as any,
      },
      select: {
        id: true,
        name: true,
        baseModel: true,
        systemPrompt: true,
        settings: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({ agent: created }, { status: 201 });
  } catch (e: any) {
    // Handle unique constraint on (userId, name)
    if (e?.code === "P2002") {
      return NextResponse.json({ message: "You already have an agent with this name" }, { status: 409 });
    }
    return NextResponse.json({ message: "Failed to create agent" }, { status: 500 });
  }
}