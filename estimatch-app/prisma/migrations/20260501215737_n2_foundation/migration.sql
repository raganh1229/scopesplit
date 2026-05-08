-- AlterTable
ALTER TABLE "comparison_version_line_items" ADD COLUMN     "unit_adjuster" TEXT,
ADD COLUMN     "unit_yours" TEXT;

-- AlterTable
ALTER TABLE "comparisons" ADD COLUMN     "inngest_run_id" TEXT,
ADD COLUMN     "pipeline_version" TEXT NOT NULL DEFAULT 'n1';

-- AlterTable
ALTER TABLE "line_items" ADD COLUMN     "unit_adjuster" TEXT,
ADD COLUMN     "unit_yours" TEXT;
