import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { hashPassword } from "../../../../lib/hash";
import { createSession } from "../../../../lib/session";
import { generateRecoveryCode } from "../../../../lib/recovery";

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ message: "Email and password required" }, { status: 400 });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ message: "Email already in use" }, { status: 409 });
    }
    const passwordHash = await hashPassword(password);
    const recoveryCode = generateRecoveryCode();

    const user = await prisma.user.create({
      data: { email, passwordHash, recoveryCode },
      select: { id: true, email: true, recoveryCode: true }
    });

    await createSession(user.id);

    // Return recoveryCode so the frontend can show it once.
    return NextResponse.json(user);
  } catch {
    return NextResponse.json({ message: "Signup failed" }, { status: 500 });
  }
}