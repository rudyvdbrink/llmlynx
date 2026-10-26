// Runs once when the server starts, before it handles requests.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { hashPlainRecoveryCodes } = await import("@/server/auth/recovery");
  const count = await hashPlainRecoveryCodes();
  if (count > 0) console.log(`Hashed ${count} recovery code(s) that were stored in plain text.`);

  const { secretsKeyProblem } = await import("@/server/secrets");
  const problem = secretsKeyProblem();
  if (problem) console.warn(`${problem}. Users cannot save or use OpenAI and OpenRouter API keys until it is fixed.`);
}
