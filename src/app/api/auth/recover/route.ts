import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { hashSecret, verifySecret } from "@/server/auth/hash";
import { destroyAllSessions } from "@/server/auth/session";
import { createAuthResponder } from "@/server/auth/respond";
import { getClientIp, optionalString, readJsonObject } from "@/server/http";
import { isRecoveryCode, MIN_PASSWORD_LENGTH, normalizeEmail } from "@/lib/authRules";

// POST /api/auth/recover
// body: { email, recoveryCode, newPassword }
// Recovery codes are stored as bcrypt hashes, so the account is found by email
// and the code is checked against that account's hash.
export async function POST(req: Request) {
  const auth = createAuthResponder("RESET", getClientIp(req));

  const limited = await auth.rateLimit("recovery", "Too many recovery attempts. Please try again later.");
  if (limited) return limited;

  try {
    const body = await readJsonObject(req);
    const email = normalizeEmail(optionalString(body.email) ?? "");
    const { recoveryCode } = body;
    const newPassword = optionalString(body.newPassword) ?? "";

    if (!email || !recoveryCode || !newPassword) {
      return auth.fail(400, "Email, recovery code and new password required", "MISSING_FIELDS", email);
    }

    if (!isRecoveryCode(recoveryCode)) {
      return auth.fail(400, "Invalid recovery code format", "INVALID_RECOVERY_CODE_FORMAT", email);
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return auth.fail(
        400,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        "PASSWORD_TOO_SHORT",
        email
      );
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!(await verifySecret(recoveryCode, user?.recoveryCodeHash)) || !user) {
      // Same message for unknown email and wrong code, to avoid an oracle
      return auth.fail(400, "Invalid email or recovery code", "INVALID_RECOVERY_CODE", email);
    }

    // Update password (keeping the same recovery code, per requirements) and
    // sign out every existing session of this account.
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashSecret(newPassword) },
    });
    await destroyAllSessions(user.id);

    await auth.succeed(user.email);

    return NextResponse.json({ ok: true });
  } catch {
    return auth.fail(500, "Recovery failed", "INTERNAL_ERROR");
  }
}
