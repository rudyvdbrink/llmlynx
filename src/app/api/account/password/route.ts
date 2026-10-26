import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { hashSecret, verifySecret } from "@/server/auth/hash";
import { destroyOtherSessions, getCurrentUser } from "@/server/auth/session";
import { createAuthResponder } from "@/server/auth/respond";
import { getClientIp, jsonError, optionalString, readJsonObject } from "@/server/http";
import { MIN_PASSWORD_LENGTH } from "@/lib/authRules";

// POST /api/account/password
// body: { currentPassword, newPassword }
// Signs the account out on every other device; this session stays signed in.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const auth = createAuthResponder("PASSWORD_CHANGE", getClientIp(req));

  const limited = await auth.rateLimit("account", "Too many attempts. Please try again later.");
  if (limited) return limited;

  try {
    const body = await readJsonObject(req);
    const currentPassword = optionalString(body.currentPassword) ?? "";
    const newPassword = optionalString(body.newPassword) ?? "";

    if (!currentPassword || !newPassword) {
      return auth.fail(400, "Current and new password required", "MISSING_FIELDS", user.email);
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return auth.fail(
        400,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        "PASSWORD_TOO_SHORT",
        user.email
      );
    }

    const account = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
    if (!(await verifySecret(currentPassword, account?.passwordHash))) {
      return auth.fail(403, "Current password is incorrect", "INVALID_PASSWORD", user.email);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashSecret(newPassword) },
    });
    await destroyOtherSessions(user.id);

    await auth.succeed(user.email);

    return NextResponse.json({ ok: true });
  } catch {
    return auth.fail(500, "Password change failed", "INTERNAL_ERROR", user.email);
  }
}
