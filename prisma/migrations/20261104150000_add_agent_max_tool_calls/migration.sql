-- How many tools an agent may call for one reply.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "maxToolCalls" INTEGER NOT NULL DEFAULT 7;
