import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { prisma } from "@/server/db/prisma";
import { hashToken } from "./hash";
import type { SessionUser } from "@/lib/types";

// The cookie holds a random token; the database only stores its hash, so a
// leaked database cannot be used to sign in.

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "app_session";
const MAX_DAYS = parseInt(process.env.SESSION_MAX_DAYS || "7", 10) || 7;

// Browsers drop Secure cookies on plain-HTTP sites other than localhost, which
// would break signing in from other devices on the local network. So the
// cookie is Secure exactly when the request came in over HTTPS (directly or
// through a proxy that sets X-Forwarded-Proto).
async function isHttpsRequest() {
  const proto = (await headers()).get("x-forwarded-proto") ?? "";
  return proto.split(",")[0].trim() === "https";
}

export async function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + MAX_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt },
  });
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await isHttpsRequest(),
    path: "/",
    expires: expiresAt,
  });
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    // deleteMany: parallel requests may race to remove the same expired session.
    await prisma.session.deleteMany({ where: { tokenHash } });
    try {
      cookieStore.delete(COOKIE_NAME);
    } catch {
      // Server Components cannot modify cookies; the stale cookie is harmless
      // because its session row is gone.
    }
    return null;
  }
  return session.user;
}

export async function destroySession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    cookieStore.delete(COOKIE_NAME);
  }
}

/** Signs a user out everywhere, e.g. after a password reset. */
export async function destroyAllSessions(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}

/** Signs a user out on every other device, keeping the current session, e.g. after a password change. */
export async function destroyOtherSessions(userId: string) {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  await prisma.session.deleteMany({
    where: { userId, ...(token ? { tokenHash: { not: hashToken(token) } } : {}) },
  });
}
