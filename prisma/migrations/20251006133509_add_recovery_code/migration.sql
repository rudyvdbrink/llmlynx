/*
  Warnings:

  - A unique constraint covering the columns `[recoveryCode]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN "recoveryCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_recoveryCode_key" ON "User"("recoveryCode");
