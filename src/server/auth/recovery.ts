import crypto from "node:crypto";
import { prisma } from "@/server/db/prisma";
import { hashSecret, isBcryptHash } from "./hash";
import { RECOVERY_CODE_LENGTH } from "@/lib/authRules";

export function generateRecoveryCode(): string {
  // Numeric digits, preserving leading zeros, using a cryptographically secure RNG
  return Array.from({ length: RECOVERY_CODE_LENGTH }, () => crypto.randomInt(0, 10)).join("");
}

/**
 * Replaces recovery codes that are still stored in plain text (left by the
 * hash_secrets migration) with their bcrypt hash. Runs at server start.
 */
export async function hashPlainRecoveryCodes(): Promise<number> {
  const users = await prisma.user.findMany({
    where: { recoveryCodeHash: { not: null } },
    select: { id: true, recoveryCodeHash: true },
  });
  const plain = users.filter((u) => u.recoveryCodeHash && !isBcryptHash(u.recoveryCodeHash));
  for (const user of plain) {
    await prisma.user.update({
      where: { id: user.id },
      data: { recoveryCodeHash: await hashSecret(user.recoveryCodeHash!) },
    });
  }
  // SQLite keeps overwritten and deleted data in free pages of the file until
  // they are reused. Rebuild the file so no plain-text codes (or the session
  // tokens dropped by the same migration) remain on disk.
  if (plain.length > 0) await prisma.$executeRawUnsafe("VACUUM");
  return plain.length;
}
