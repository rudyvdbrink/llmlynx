import { NextResponse } from "next/server";
import { prisma } from "../../../../server/db/prisma";
import { verifyPassword } from "../../../../server/auth/hash";
import { createSession } from "../../../../server/auth/session";
import { checkRateLimit } from "../../../../server/limits/rateLimit";
import { logAuthEvent } from "../../../../server/logging/authLogger";

export async function POST(req: Request) {
  const ip =
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    null;

  // Rate limit per IP for login attempts
  const rl = checkRateLimit("login", ip);
  if (!rl.allowed) {
    await logAuthEvent({
      type: "LOGIN",
      outcome: "FAILURE",
      reason: "RATE_LIMITED",
      ip,
    });
    return NextResponse.json(
      { message: "Too many login attempts. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": Math.max(1, Math.round((rl.resetAt - Date.now()) / 1000)).toString(),
        },
      }
    );
  }

  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      await logAuthEvent({
        type: "LOGIN",
        outcome: "FAILURE",
        email,
        reason: "MISSING_CREDENTIALS",
        ip,
      });
      return NextResponse.json({ message: "Email and password required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      await logAuthEvent({
        type: "LOGIN",
        outcome: "FAILURE",
        email,
        reason: "USER_NOT_FOUND_OR_INVALID_CREDENTIALS",
        ip,
      });
      return NextResponse.json({ message: "Invalid credentials" }, { status: 401 });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      await logAuthEvent({
        type: "LOGIN",
        outcome: "FAILURE",
        email,
        reason: "USER_NOT_FOUND_OR_INVALID_CREDENTIALS",
        ip,
      });
      return NextResponse.json({ message: "Invalid credentials" }, { status: 401 });
    }

    await createSession(user.id);

    await logAuthEvent({
      type: "LOGIN",
      outcome: "SUCCESS",
      email: user.email,
      ip,
    });

    return NextResponse.json({ id: user.id, email: user.email });
  } catch {
    await logAuthEvent({
      type: "LOGIN",
      outcome: "FAILURE",
      reason: "INTERNAL_ERROR",
      ip,
    });
    return NextResponse.json({ message: "Login failed" }, { status: 500 });
  }
}