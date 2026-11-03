-- What each reply was generated with besides the conversation (system prompt,
-- options, tools), stored once per distinct setup. Existing replies get none.

-- CreateTable
CREATE TABLE "RequestSetup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "options" JSONB,
    "tools" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RequestSetup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
    "setupId" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "RequestSetup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Message" ("content", "conversationId", "createdAt", "id", "metadata", "model", "position", "reasoning", "role", "toolCallId", "toolCalls", "toolName") SELECT "content", "conversationId", "createdAt", "id", "metadata", "model", "position", "reasoning", "role", "toolCallId", "toolCalls", "toolName" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
CREATE INDEX "Message_conversationId_position_idx" ON "Message"("conversationId", "position");
CREATE INDEX "Message_setupId_idx" ON "Message"("setupId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RequestSetup_userId_hash_key" ON "RequestSetup"("userId", "hash");
