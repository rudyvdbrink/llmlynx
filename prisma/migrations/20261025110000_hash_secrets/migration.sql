-- Store secrets as hashes only.
--
-- Recovery codes: the column is renamed and still holds the old plain-text
-- codes after this migration. The server hashes them with bcrypt when it starts
-- (src/instrumentation.ts), before it serves any request.
--
-- Session tokens: SQLite cannot hash them, so existing sessions are removed and
-- users sign in once more.

-- DropIndex
DROP INDEX "User_recoveryCode_key";

-- AlterTable
ALTER TABLE "User" RENAME COLUMN "recoveryCode" TO "recoveryCodeHash";

-- DropTable
DROP TABLE "Session";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
