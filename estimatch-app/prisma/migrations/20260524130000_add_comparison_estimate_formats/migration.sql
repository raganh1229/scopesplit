-- AddColumn: user-selected estimate format for contractor's PDF
ALTER TABLE "comparisons" ADD COLUMN IF NOT EXISTS "your_estimate_format" TEXT NOT NULL DEFAULT 'xactimate';

-- AddColumn: user-selected estimate format for adjuster's PDF
ALTER TABLE "comparisons" ADD COLUMN IF NOT EXISTS "adjuster_estimate_format" TEXT NOT NULL DEFAULT 'xactimate';
