// What the security rules know about a conversation: whether text that looked
// like instructions aimed at the model has reached it. It is built from the
// stored conversation only, never from the client, and kept up to date in
// memory while a reply runs.

export type SecurityContext = {
  /** Flagged text is in the conversation, or was withheld from it. Never goes back to false. */
  tainted: boolean;
};

/** An empty context. */
export function createSecurityContext(): SecurityContext {
  return { tainted: false };
}

/** A stored tool step of a conversation, as the context is built from it. */
export type StoredStep = { metadata: unknown };

/** The context of a conversation with these stored tool steps: tainted when one was flagged as a prompt injection. */
export function contextFromSteps(steps: StoredStep[]): SecurityContext {
  const context = createSecurityContext();
  for (const step of steps) {
    const meta = step.metadata as { security?: { flag?: unknown } } | null;
    if (meta?.security?.flag === "injection") context.tainted = true;
  }
  return context;
}
