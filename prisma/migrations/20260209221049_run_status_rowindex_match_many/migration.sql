-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('OPEN', 'CLOSED');

-- DropIndex
DROP INDEX "Match_extractLineId_key";

-- DropIndex
DROP INDEX "Match_systemLineId_key";

-- AlterTable
ALTER TABLE "ReconciliationRun" ADD COLUMN     "status" "RunStatus" NOT NULL DEFAULT 'OPEN';

-- AlterTable
ALTER TABLE "SystemLine" ADD COLUMN     "rowIndex" INTEGER;
