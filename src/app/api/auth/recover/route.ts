import { NextResponse } from "next/server";
import { prisma } from "../../../../server/db/prisma";
import { hashPassword } from "../../../../server/auth/hash";
import { logAuthEvent } from "../../../../server/logging/authLogger";

export async function POST(req: Request) {
  const ip =
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    null;

  try {
    const { recoveryCode, newPassword } = await req.json();

    if (!recoveryCode || !newPassword) {
      await logAuthEvent({
        type: "RESET",
        outcome: "FAILURE",
        reason: "MISSING_FIELDS",
        ip,
      });
      return NextResponse.json(
        { message: "Recovery code and new password required" },
        { status: 400 }
      );
    }

    if (!/^[0-9]{12}$/.test(recoveryCode)) {
      await logAuthEvent({
        type: "RESET",
        outcome: "FAILURE",
        reason: "INVALID_RECOVERY_CODE_FORMAT",
        ip,
      });
      return NextResponse.json(
        { message: "Invalid recovery code format" },
        { status: 400 }
      );
    }

    if (typeof newPassword !== "string" || newPassword.length < 8) {
      await logAuthEvent({
        type: "RESET",
        outcome: "FAILURE",
        reason: "PASSWORD_TOO_SHORT",
        ip,
      });
      return NextResponse.json(
        { message: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { recoveryCode },
    });

    if (!user) {
      // Generic message to avoid oracle
      await logAuthEvent({
        type: "RESET",
        outcome: "FAILURE",
        reason: "INVALID_RECOVERY_CODE",
        ip,
      });
      return NextResponse.json(
        { message: "Invalid recovery code" },
        { status: 400 }
      );
    }

    const passwordHash = await hashPassword(newPassword);

    // Update password (keeping the same recovery code, per requirements).
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    await logAuthEvent({
      type: "RESET",
      outcome: "SUCCESS",
      email: user.email,
      ip,
    });

    return NextResponse.json({ ok: true });
  } catch {
    await logAuthEvent({
      type: "RESET",
      outcome: "FAILURE",
      reason: "INTERNAL_ERROR",
      ip,
    });
    return NextResponse.json({ message: "Recovery failed" }, { status: 500 });
  }
}