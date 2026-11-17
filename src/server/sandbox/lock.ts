// One run at a time per chat: a run of code or an install of packages waits
// until the chat's previous one is done. The code container also lets only a
// few run at once on the whole server (CODE_MAX_CONCURRENCY).

const busy = new Map<string, Promise<void>>();

/** Runs `work` when no other work of the chat `conversationId` runs, and returns what it returns. */
export async function withChatLock<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
  const before = busy.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const queue = before.then(() => mine);
  busy.set(conversationId, queue);
  await before;
  try {
    return await work();
  } finally {
    release();
    if (busy.get(conversationId) === queue) busy.delete(conversationId);
  }
}
