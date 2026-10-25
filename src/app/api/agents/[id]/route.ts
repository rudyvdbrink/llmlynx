import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { AGENT_SELECT, agentNameError, DUPLICATE_NAME_MESSAGE } from "@/server/agents";
import { jsonError, readJsonObject } from "@/server/http";
import { validateAgentSettings } from "@/lib/agentSettings";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/agents/:id
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const agent = await prisma.agent.findFirst({ where: { id, userId: user.id }, select: AGENT_SELECT });
  if (!agent) return jsonError("Not found", 404);

  return NextResponse.json({ agent });
}

// PATCH /api/agents/:id -> update name/baseModel/systemPrompt/settings
export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const owned = await prisma.agent.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!owned) return jsonError("Not found", 404);

  const body = await readJsonObject(req);
  const data: Prisma.AgentUpdateInput = {};

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) return jsonError("Name cannot be empty", 400);
    const nameError = agentNameError(name);
    if (nameError) return jsonError(nameError, 400);
    data.name = name;
  }
  if (typeof body.baseModel === "string") {
    const baseModel = body.baseModel.trim();
    if (!baseModel) return jsonError("Base model cannot be empty", 400);
    data.baseModel = baseModel;
  }
  if (typeof body.systemPrompt === "string" || body.systemPrompt === null) {
    data.systemPrompt = body.systemPrompt;
  }
  if (body.settings !== undefined) {
    const settings = validateAgentSettings(body.settings);
    if (!settings.ok) return jsonError(settings.message, 400);
    data.settings = settings.value;
  }

  try {
    const agent = await prisma.agent.update({ where: { id }, data, select: AGENT_SELECT });
    return NextResponse.json({ agent });
  } catch (err) {
    if (isUniqueConstraintError(err)) return jsonError(DUPLICATE_NAME_MESSAGE, 409);
    return jsonError("Failed to update agent", 500);
  }
}

// DELETE /api/agents/:id
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const { count } = await prisma.agent.deleteMany({ where: { id, userId: user.id } });
  if (count === 0) return jsonError("Not found", 404);

  return new NextResponse(null, { status: 204 });
}
