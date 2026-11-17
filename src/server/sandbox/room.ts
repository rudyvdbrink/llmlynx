// The limits of a chat's sandbox: 20 MB per file, and 100 MB for its files
// together (the newest version of each). A tool that would go over them gets
// an error the model can act on.

import { formatSize, MAX_FILE_BYTES, MAX_SANDBOX_BYTES } from "@/lib/files";
import { conversationFiles, type ConversationFile } from "@/server/files/store";

/**
 * Why the files `incoming` (new versions or new files, by path) cannot be
 * stored in the sandbox whose files are `files`, once `deletions` are gone, or
 * null when they fit.
 */
export function roomError(
  files: Pick<ConversationFile, "name" | "size">[],
  incoming: { name: string; size: number }[],
  deletions: string[] = []
): string | null {
  const sizes = new Map(files.map((f) => [f.name.toLowerCase(), f.size]));
  for (const name of deletions) sizes.delete(name.toLowerCase());
  for (const file of incoming) {
    if (file.size > MAX_FILE_BYTES) return `${file.name} would be ${formatSize(file.size)}, more than the 20 MB a file can have.`;
    sizes.set(file.name.toLowerCase(), file.size);
  }
  let total = 0;
  for (const size of sizes.values()) total += size;
  if (total <= MAX_SANDBOX_BYTES) return null;
  return (
    `the chat's sandbox would hold ${formatSize(total)}, more than its 100 MB. ` +
    "Make the files smaller, or remove files that are no longer needed."
  );
}

/** As roomError, for the conversation's sandbox as it is now. */
export async function sandboxRoomError(
  conversationId: string,
  incoming: { name: string; size: number }[],
  deletions: string[] = []
): Promise<string | null> {
  return roomError(await conversationFiles(conversationId), incoming, deletions);
}
