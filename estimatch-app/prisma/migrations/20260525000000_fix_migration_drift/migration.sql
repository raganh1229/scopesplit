-- FixDrift: reconcile raw SQL changes that were applied outside of Prisma
-- migrations (N3-4). Both changes below were applied directly to the database
-- during development. This migration file makes Prisma's migration history
-- consistent with the actual DB schema.
--
-- After creating this file, mark it as already applied (do NOT re-run it):
--   npx prisma migrate resolve --applied 20260525000000_fix_migration_drift
--
-- WARNING: Do NOT run prisma migrate reset on production.

-- 1. Add AWAITING_LINE_ITEM_REVIEW to comparison_status enum (if not present)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'AWAITING_LINE_ITEM_REVIEW'
      AND enumtypid = (
        SELECT oid FROM pg_type WHERE typname = 'comparison_status'
      )
  ) THEN
    ALTER TYPE "comparison_status" ADD VALUE 'AWAITING_LINE_ITEM_REVIEW';
  END IF;
END $$;

-- 2. Add embedding column to n3_line_items (if not present)
-- voyage-3-lite produces 512-dimension vectors; pgvector extension must be
-- enabled (CREATE EXTENSION IF NOT EXISTS vector) on the database.
ALTER TABLE "n3_line_items" ADD COLUMN IF NOT EXISTS "embedding" vector(512);
