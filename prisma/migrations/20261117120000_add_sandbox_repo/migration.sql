-- The chats' git repositories: their .git folders (see SandboxRepo in schema.prisma).
-- CreateTable
CREATE TABLE "SandboxRepo" (
    "conversationId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "git" BLOB NOT NULL,
    "size" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("conversationId", "path"),
    CONSTRAINT "SandboxRepo_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
