-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'ANALYST', 'AUDITOR');

-- CreateEnum
CREATE TYPE "UnmatchedSystemStatus" AS ENUM ('OVERDUE', 'DEFERRED');

-- CreateEnum
CREATE TYPE "PendingStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ChequeStatus" AS ENUM ('ISSUED', 'CLEARED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "RunMemberRole" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'ANALYST',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "bankName" TEXT,
    "accountRef" TEXT,
    "windowDays" INTEGER NOT NULL DEFAULT 0,
    "cutDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunMember" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RunMemberRole" NOT NULL DEFAULT 'EDITOR',

    CONSTRAINT "RunMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractLine" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "concept" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "amountKey" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "categoryId" TEXT,

    CONSTRAINT "ExtractLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLine" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "amount" DOUBLE PRECISION NOT NULL,
    "amountKey" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,

    CONSTRAINT "SystemLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "extractLineId" TEXT NOT NULL,
    "systemLineId" TEXT NOT NULL,
    "deltaDays" INTEGER NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnmatchedExtract" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "extractLineId" TEXT NOT NULL,

    CONSTRAINT "UnmatchedExtract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnmatchedSystem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "systemLineId" TEXT NOT NULL,
    "status" "UnmatchedSystemStatus" NOT NULL,

    CONSTRAINT "UnmatchedSystem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseRule" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "isRegex" BOOLEAN NOT NULL DEFAULT false,
    "caseSensitive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ExpenseRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "status" "PendingStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "systemLineId" TEXT,

    CONSTRAINT "PendingItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cheque" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "number" TEXT,
    "issueDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "ChequeStatus" NOT NULL DEFAULT 'ISSUED',
    "note" TEXT,

    CONSTRAINT "Cheque_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RunMember_runId_userId_key" ON "RunMember"("runId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_extractLineId_key" ON "Match"("extractLineId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_systemLineId_key" ON "Match"("systemLineId");

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedExtract_extractLineId_key" ON "UnmatchedExtract"("extractLineId");

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedSystem_systemLineId_key" ON "UnmatchedSystem"("systemLineId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_name_key" ON "ExpenseCategory"("name");

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunMember" ADD CONSTRAINT "RunMember_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunMember" ADD CONSTRAINT "RunMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractLine" ADD CONSTRAINT "ExtractLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractLine" ADD CONSTRAINT "ExtractLine_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemLine" ADD CONSTRAINT "SystemLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_extractLineId_fkey" FOREIGN KEY ("extractLineId") REFERENCES "ExtractLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_systemLineId_fkey" FOREIGN KEY ("systemLineId") REFERENCES "SystemLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedExtract" ADD CONSTRAINT "UnmatchedExtract_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedExtract" ADD CONSTRAINT "UnmatchedExtract_extractLineId_fkey" FOREIGN KEY ("extractLineId") REFERENCES "ExtractLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedSystem" ADD CONSTRAINT "UnmatchedSystem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedSystem" ADD CONSTRAINT "UnmatchedSystem_systemLineId_fkey" FOREIGN KEY ("systemLineId") REFERENCES "SystemLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRule" ADD CONSTRAINT "ExpenseRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingItem" ADD CONSTRAINT "PendingItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingItem" ADD CONSTRAINT "PendingItem_systemLineId_fkey" FOREIGN KEY ("systemLineId") REFERENCES "SystemLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cheque" ADD CONSTRAINT "Cheque_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
