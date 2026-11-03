-- Messages become steps of a conversation trace: reasoning, tool calls and tool
-- results, the model that wrote each reply, and an explicit order. Existing
-- messages are numbered in the order they were shown in: by createdAt, then by
-- insertion order.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "reasoning" TEXT,
    "toolCalls" JSONB,
    "toolCallId" TEXT,
    "toolName" TEXT,
    "model" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Message" ("content", "conversationId", "createdAt", "id", "role", "position")
SELECT "content", "conversationId", "createdAt", "id", "role",
       ROW_NUMBER() OVER (PARTITION BY "conversationId" ORDER BY "createdAt", rowid) - 1
FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
CREATE INDEX "Message_conversationId_position_idx" ON "Message"("conversationId", "position");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
