-- AddIndex: HNSW approximate-nearest-neighbour index on n3_line_items.embedding
-- Enables Phase 12 (generate-candidates) to use index-accelerated cosine similarity
-- search instead of a full O(n×m) sequential scan.
-- IF NOT EXISTS makes this idempotent (safe to re-apply).
-- Note: CONCURRENTLY is omitted so the statement runs inside the migration transaction;
-- at current table sizes this lock is imperceptible. For future large-scale rebuilds,
-- run REINDEX INDEX CONCURRENTLY n3_line_items_embedding_hnsw directly on Supabase.
CREATE INDEX IF NOT EXISTS n3_line_items_embedding_hnsw
  ON n3_line_items USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
