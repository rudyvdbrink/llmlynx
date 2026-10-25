import { NextResponse } from "next/server";
import { prisma, isUniqueConstraintError } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { AGENT_SELECT, agentNameError, DUPLICATE_NAME_MESSAGE } from "@/server/agents";
import { jsonError, optionalString, readJsonObject } from "@/server/http";
import { validateAgentSettings } from "@/lib/agentSettings";

// GET /api/agents -> list current user's agents
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

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
  if (!user) return jsonError("Unauthorized", 401);

  const body = await readJsonObject(req);
  const name = (optionalString(body.name) ?? "").trim();
  const baseModel = (optionalString(body.baseModel) ?? "").trim();

  if (!name) return jsonError("Name is required", 400);
  if (!baseModel) return jsonError("Base model is required", 400);
  const nameError = agentNameError(name);
  if (nameError) return jsonError(nameError, 400);

  const settings = validateAgentSettings(body.settings);
  if (!settings.ok) return jsonError(settings.message, 400);

  try {
    const agent = await prisma.agent.create({
      data: {
        userId: user.id,
        name,
        baseModel,
        systemPrompt: optionalString(body.systemPrompt) ?? null,
        settings: settings.value,
      },
      select: AGENT_SELECT,
    });

    return NextResponse.json({ agent }, { status: 201 });
  } catch (err) {
    if (isUniqueConstraintError(err)) return jsonError(DUPLICATE_NAME_MESSAGE, 409);
    return jsonError("Failed to create agent", 500);
  }
}
