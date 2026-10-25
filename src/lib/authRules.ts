// Credential rules shared by the auth forms and the auth API routes.

export const MIN_PASSWORD_LENGTH = 8;

export const RECOVERY_CODE_LENGTH = 12;

export function isRecoveryCode(code: unknown): code is string {
  return typeof code === "string" && new RegExp(`^[0-9]{${RECOVERY_CODE_LENGTH}}$`).test(code);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
