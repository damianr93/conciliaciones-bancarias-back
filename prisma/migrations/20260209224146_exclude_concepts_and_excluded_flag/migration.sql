-- AlterTable
ALTER TABLE "ExtractLine" ADD COLUMN     "excluded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ReconciliationRun" ADD COLUMN     "excludeConcepts" JSONB DEFAULT '[]';
