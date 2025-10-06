import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { verifyPassword } from "../../../../lib/hash";
import { createSession } from "../../../../lib/session";

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ message: "Email and password required" }, { status: 400 });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return NextResponse.json({ message: "Invalid credentials" }, { status: 401 });
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return NextResponse.json({ message: "Invalid credentials" }, { status: 401 });
    }
    await createSession(user.id);
    return NextResponse.json({ id: user.id, email: user.email });
  } catch {
    return NextResponse.json({ message: "Login failed" }, { status: 500 });
  }
}