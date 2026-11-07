-- Attachments get a name, size, the text the model reads and what converting
-- them found, and can be derived from another attachment (see schema.prisma).
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MessageAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BLOB NOT NULL,
    "name" TEXT,
    "size" INTEGER,
    "text" TEXT,
    "info" JSONB,
    "parentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageAttachment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MessageAttachment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MessageAttachment" ("createdAt", "data", "id", "messageId", "mimeType", "size") SELECT "createdAt", "data", "id", "messageId", "mimeType", length("data") FROM "MessageAttachment";
DROP TABLE "MessageAttachment";
ALTER TABLE "new_MessageAttachment" RENAME TO "MessageAttachment";
CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");
CREATE INDEX "MessageAttachment_parentId_idx" ON "MessageAttachment"("parentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
