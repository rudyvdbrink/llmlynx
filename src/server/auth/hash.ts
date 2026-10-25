import crypto from "node:crypto";
import bcrypt from "bcrypt";

const ROUNDS = 12;

/** Salted bcrypt hash, for passwords and recovery codes. */
export async function hashSecret(secret: string) {
  return bcrypt.hash(secret, ROUNDS);
}

// Hash of a random value, checked against when there is no stored hash.
let dummyHash: Promise<string> | null = null;

/**
 * Checks `secret` against a bcrypt `hash`. Without a hash (e.g. unknown email)
 * it does the same work and returns false, so response times do not reveal
 * which accounts exist.
 */
export async function verifySecret(secret: string, hash: string | null | undefined) {
  if (hash) return bcrypt.compare(secret, hash);
  dummyHash ??= bcrypt.hash(crypto.randomBytes(16).toString("hex"), ROUNDS);
  await bcrypt.compare(secret, await dummyHash);
  return false;
}

export function isBcryptHash(value: string) {
  return /^\$2[aby]\$\d{2}\$/.test(value);
}

/**
 * SHA-256 of a session token. Tokens are 256 random bits, so a fast hash is
 * enough; it lets the database look sessions up without storing the token.
 */
export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
