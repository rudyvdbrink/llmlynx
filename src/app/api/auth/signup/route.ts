import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { hashSecret } from "@/server/auth/hash";
import { createSession } from "@/server/auth/session";
import { generateRecoveryCode } from "@/server/auth/recovery";
import { isEmailAllowed } from "@/server/auth/allowlist";
import { createAuthResponder } from "@/server/auth/respond";
import { getClientIp, optionalString, readJsonObject } from "@/server/http";
import { MIN_PASSWORD_LENGTH, normalizeEmail } from "@/lib/authRules";

export async function POST(req: Request) {
  const auth = createAuthResponder("SIGNUP", getClientIp(req));

  const limited = await auth.rateLimit("signup", "Too many signup attempts. Please try again later.");
  if (limited) return limited;

  try {
    const body = await readJsonObject(req);
    const email = normalizeEmail(optionalString(body.email) ?? "");
    const password = optionalString(body.password) ?? "";

    if (!email || !password) {
      return auth.fail(400, "Email and password required", "MISSING_CREDENTIALS", email);
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return auth.fail(
        400,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        "PASSWORD_TOO_SHORT",
        email
      );
    }

    // Enforce environment-based allow list for new signups.
    // If ALLOWED_SIGNUP_EMAILS is not configured or empty, isEmailAllowed()
    // will return true and signups are unrestricted.
    if (!isEmailAllowed(email)) {
      return auth.fail(
        403,
        "Signups are restricted. Please contact the administrator.",
        "NOT_ALLOWED_BY_ALLOWLIST",
        email
      );
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return auth.fail(409, "Email already in use", "EMAIL_ALREADY_IN_USE", email);
    }

    // Only the hash is stored; the code itself is returned once for the user to save.
    const recoveryCode = generateRecoveryCode();
    const user = await prisma.user.create({
      data: { email, passwordHash: await hashSecret(password), recoveryCodeHash: await hashSecret(recoveryCode) },
      select: { id: true, email: true },
    });

    await createSession(user.id);
    await auth.succeed(user.email);

    return NextResponse.json({ ...user, recoveryCode });
  } catch {
    return auth.fail(500, "Signup failed", "INTERNAL_ERROR");
  }
}
