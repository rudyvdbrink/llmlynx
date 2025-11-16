import crypto from "crypto";

export function generateRecoveryCode(): string {
  // 12 numeric digits, preserving leading zeros, using a cryptographically secure RNG
  let code = "";
  for (let i = 0; i < 12; i++) {
    const digit = crypto.randomInt(0, 10); // 0–9 inclusive
    code += digit.toString();
  }
  return code;
}