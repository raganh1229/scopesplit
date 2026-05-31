-- AddColumn: AI-detected column map for contractor's XLS spreadsheet (JSON, nullable)
ALTER TABLE "comparisons" ADD COLUMN IF NOT EXISTS "xls_column_map_yours" JSONB;

-- AddColumn: AI-detected column map for adjuster's XLS spreadsheet (JSON, nullable)
ALTER TABLE "comparisons" ADD COLUMN IF NOT EXISTS "xls_column_map_adj" JSONB;
