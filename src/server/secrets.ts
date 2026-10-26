import crypto from "node:crypto";

// API keys must be readable to call the provider, so they cannot be hashed like
// passwords. They are encrypted with AES-256-GCM under SECRETS_KEY, which lives
// only in the environment: a copy of the database alone does not reveal them.
//
// Each value is bound to a context string (user and provider), so an encrypted
// key copied into another user's row does not decrypt.

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

export class SecretsKeyError extends Error {}

let cachedKey: Buffer | null = null;

/** Returns why SECRETS_KEY cannot be used, or null when it is valid. */
export function secretsKeyProblem(): string | null {
  try {
    getKey();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.SECRETS_KEY?.trim() ?? "";
  if (!raw) throw new SecretsKeyError("SECRETS_KEY is not set");
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new SecretsKeyError("SECRETS_KEY must be 32 random bytes, base64 or hex encoded");
  cachedKey = key;
  return key;
}

export function encryptSecret(plain: string, context: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  // Stored as "v1:<iv>:<auth tag>:<ciphertext>", each part base64.
  return [VERSION, ...[iv, cipher.getAuthTag(), data].map((part) => part.toString("base64"))].join(":");
}

/** Throws when the value was encrypted under another key or context, or was altered. */
export function decryptSecret(stored: string, context: string): string {
  const [version, ...parts] = stored.split(":");
  if (version !== VERSION || parts.length !== 3) throw new Error("Unknown secret format");
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64"));
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
