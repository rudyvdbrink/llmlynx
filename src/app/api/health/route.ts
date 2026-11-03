import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";

// Probed by the container healthcheck: no auth, and fails if the database cannot be read.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
