import { NextResponse } from "next/server";
import { prisma } from "../../../../server/db/prisma";
import { hashPassword } from "../../../../server/auth/hash";
import { createSession } from "../../../../server/auth/session";
import { generateRecoveryCode } from "../../../../server/auth/recovery";
import { isEmailAllowed } from "../../../../server/auth/allowlist";

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ message: "Email and password required" }, { status: 400 });
    }

    // Enforce environment-based allow list for new signups
    if (!isEmailAllowed(email)) {
      return NextResponse.json(
        { message: "Signups are restricted. Please contact the administrator." },
        { status: 403 }
      );
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