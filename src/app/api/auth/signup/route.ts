import { NextResponse } from "next/server";
import { prisma } from "../../../../server/db/prisma";
import { hashPassword } from "../../../../server/auth/hash";
import { createSession } from "../../../../server/auth/session";
import { generateRecoveryCode } from "../../../../server/auth/recovery";
import { isEmailAllowed } from "../../../../server/auth/allowlist";
import { checkRateLimit } from "../../../../server/limits/rateLimit";
import { logAuthEvent } from "../../../../server/logging/authLogger";

export async function POST(req: Request) {
  const ip =
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    null;

  // Rate limit per IP for signup attempts
  const rl = checkRateLimit("signup", ip);
  if (!rl.allowed) {
    await logAuthEvent({
      type: "SIGNUP",
      outcome: "FAILURE",
      reason: "RATE_LIMITED",
      ip,
    });
    return NextResponse.json(
      { message: "Too many signup attempts. Please try again later." },
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
        type: "SIGNUP",
        outcome: "FAILURE",
        email,
        reason: "MISSING_CREDENTIALS",
        ip,
      });
      return NextResponse.json({ message: "Email and password required" }, { status: 400 });
    }

    // Enforce environment-based allow list for new signups.
    // If ALLOWED_SIGNUP_EMAILS is not configured or empty, isEmailAllowed()
    // will return true and signups are unrestricted.
    if (!isEmailAllowed(email)) {
      await logAuthEvent({
        type: "SIGNUP",
        outcome: "FAILURE",
        email,
        reason: "NOT_ALLOWED_BY_ALLOWLIST",
        ip,
      });
      return NextResponse.json(
        { message: "Signups are restricted. Please contact the administrator." },
        { status: 403 }
      );
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      await logAuthEvent({
        type: "SIGNUP",
        outcome: "FAILURE",
        email,
        reason: "EMAIL_ALREADY_IN_USE",
        ip,
      });
      return NextResponse.json({ message: "Email already in use" }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const recoveryCode = generateRecoveryCode();

    const user = await prisma.user.create({
      data: { email, passwordHash, recoveryCode },
      select: { id: true, email: true, recoveryCode: true },
    });

    await createSession(user.id);

    await logAuthEvent({
      type: "SIGNUP",
      outcome: "SUCCESS",
      email: user.email,
      ip,
    });

    // Return recoveryCode so the frontend can show it once.
    return NextResponse.json(user);
  } catch {
    await logAuthEvent({
      type: "SIGNUP",
      outcome: "FAILURE",
      reason: "INTERNAL_ERROR",
      ip,
    });
    return NextResponse.json({ message: "Signup failed" }, { status: 500 });
  }
}