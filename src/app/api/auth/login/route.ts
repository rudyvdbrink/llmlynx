import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { verifySecret } from "@/server/auth/hash";
import { createSession } from "@/server/auth/session";
import { createAuthResponder } from "@/server/auth/respond";
import { getClientIp, optionalString, readJsonObject } from "@/server/http";
import { normalizeEmail } from "@/lib/authRules";

export async function POST(req: Request) {
  const auth = createAuthResponder("LOGIN", getClientIp(req));

  const limited = await auth.rateLimit("login", "Too many login attempts. Please try again later.");
  if (limited) return limited;

  try {
    const body = await readJsonObject(req);
    const email = normalizeEmail(optionalString(body.email) ?? "");
    const password = optionalString(body.password) ?? "";

    if (!email || !password) {
      return auth.fail(400, "Email and password required", "MISSING_CREDENTIALS", email);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!(await verifySecret(password, user?.passwordHash)) || !user) {
      return auth.fail(401, "Invalid credentials", "USER_NOT_FOUND_OR_INVALID_CREDENTIALS", email);
    }

    await createSession(user.id);
    await auth.succeed(user.email);

    return NextResponse.json({ id: user.id, email: user.email });
  } catch {
    return auth.fail(500, "Login failed", "INTERNAL_ERROR");
  }
}
