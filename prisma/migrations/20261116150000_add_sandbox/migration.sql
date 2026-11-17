-- The chat's sandbox: runs of code, installed packages, and where its files came from (see schema.prisma).
-- CreateTable
CREATE TABLE "SandboxRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "files" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SandboxRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SandboxPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "requested" BOOLEAN NOT NULL,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SandboxPackage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SandboxLock" (
    "conversationId" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "requested" JSONB NOT NULL,
    "lock" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("conversationId", "ecosystem"),
    CONSTRAINT "SandboxLock_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable: new columns only, so the files are not copied
ALTER TABLE "MessageAttachment" ADD COLUMN "origin" TEXT;
ALTER TABLE "MessageAttachment" ADD COLUMN "deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MessageAttachment" ADD COLUMN "scans" JSONB;

-- CreateIndex
CREATE INDEX "SandboxRun_conversationId_createdAt_idx" ON "SandboxRun"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "SandboxPackage_conversationId_idx" ON "SandboxPackage"("conversationId");
