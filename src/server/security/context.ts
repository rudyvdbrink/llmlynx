// What the security rules know about a conversation: whether text that looked
// like instructions aimed at the model has reached it. It is built from the
// stored conversation only, never from the client, and kept up to date in
// memory while a reply runs. A flag the user marked a false positive does not
// count.

export type SecurityContext = {
  /**
   * Flagged text is in the conversation, or was withheld from it. Goes back to
   * false only when the user marks the flags false positives (see stillTainted).
   */
  tainted: boolean;
  /** Flagged text was left out of a result in this reply with no flag stored on its step, which no mark takes back */
  leftOut?: boolean;
};

/** An empty context. */
export function createSecurityContext(): SecurityContext {
  return { tainted: false };
}

/** A stored tool step of a conversation, as the context is built from it. */
export type StoredStep = { metadata: unknown };

/**
 * The context of a conversation with these stored tool steps: tainted when one
 * was flagged as a prompt injection that the user did not mark a false positive.
 */
export function contextFromSteps(steps: StoredStep[]): SecurityContext {
  const context = createSecurityContext();
  for (const step of steps) {
    const meta = step.metadata as { security?: { flag?: unknown; falsePositive?: unknown } } | null;
    if (meta?.security?.flag === "injection" && meta.security.falsePositive !== true) context.tainted = true;
  }
  return context;
}
