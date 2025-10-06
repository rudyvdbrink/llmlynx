import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { hashPassword } from "../../../../lib/hash";

export async function POST(req: Request) {
  try {
    const { recoveryCode, newPassword } = await req.json();

    if (!recoveryCode || !newPassword) {
      return NextResponse.json({ message: "Recovery code and new password required" }, { status: 400 });
    }

    if (!/^[0-9]{12}$/.test(recoveryCode)) {
      return NextResponse.json({ message: "Invalid recovery code format" }, { status: 400 });
    }

    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return NextResponse.json({ message: "Password must be at least 8 characters" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { recoveryCode }
    });

    if (!user) {
      // Generic message to avoid oracle
      return NextResponse.json({ message: "Invalid recovery code" }, { status: 400 });
    }

    const passwordHash = await hashPassword(newPassword);

    // Update password (keeping the same recovery code, per requirements).
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash }
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "Recovery failed" }, { status: 500 });
  }
}