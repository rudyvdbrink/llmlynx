import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { verifySecret } from "@/server/auth/hash";
import { destroySession, getCurrentUser } from "@/server/auth/session";
import { createAuthResponder } from "@/server/auth/respond";
import { getClientIp, jsonError, optionalString, readJsonObject } from "@/server/http";

// DELETE /api/account
// body: { password }
// Deletes the account with its sessions, conversations, agents and provider settings.
export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const auth = createAuthResponder("DELETE_ACCOUNT", getClientIp(req));

  const limited = await auth.rateLimit("account", "Too many attempts. Please try again later.");
  if (limited) return limited;

  try {
    const password = optionalString((await readJsonObject(req)).password) ?? "";
    if (!password) return auth.fail(400, "Password required", "MISSING_FIELDS", user.email);

    const account = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
    if (!(await verifySecret(password, account?.passwordHash))) {
      return auth.fail(403, "Password is incorrect", "INVALID_PASSWORD", user.email);
    }

    // Everything else that belongs to the user is removed by cascading deletes.
    await prisma.user.delete({ where: { id: user.id } });
    await destroySession();

    await auth.succeed(user.email);

    return NextResponse.json({ ok: true });
  } catch {
    return auth.fail(500, "Account deletion failed", "INTERNAL_ERROR", user.email);
  }
}
