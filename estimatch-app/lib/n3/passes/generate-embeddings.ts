// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 11: generate-embeddings
//
// Generates 512-dimension dense vector embeddings for every n3_line_items row
// using the Voyage AI voyage-3-lite model. Vectors are stored in the
// `embedding vector(512)` column added via the Phase 11 SQL migration.
//
// Why Voyage AI: Anthropic's recommended embedding partner (acquired by
// Anthropic). voyage-3-lite produces 512-dim vectors optimised for short
// domain-specific text — ideal for insurance line item descriptions.
//
// Idempotent: rows with an existing non-null embedding are skipped unless
// `force=true` is passed, so the step can be safely re-run after prompt
// changes or partial failures.
//
// Phase 12 (candidate generation) consumes these vectors for ANN cosine
// similarity search across the yours/adjuster split.
//
// Architecture refs: N3.md §Phase 11, §15.2 (candidate sources — semantic ANN)
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3-lite'; // 512 dimensions, cost-efficient
const BATCH_SIZE = 64; // Voyage supports up to 128; 64 is safe headroom

// ── Return type ───────────────────────────────────────────────────────────────

export type GenerateEmbeddingsN3Result = {
  totalRows: number;
  embedded: number;
  skipped: number;
  batches: number;
};

// ── Internal helpers ──────────────────────────────────────────────────────────

async function callVoyageEmbeddings(
  texts: string[],
  apiKey: string,
): Promise<number[][]> {
  const res = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: texts }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage AI error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
  };

  if (json.data.length !== texts.length) {
    throw new Error(
      `[n3/generate-embeddings] Voyage returned ${json.data.length} vectors for ${texts.length} inputs — partial batch response`,
    );
  }

  // Return in original order
  return json.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateEmbeddingsN3(
  comparisonId: string,
  logger: StepLogger,
  force = false,
): Promise<GenerateEmbeddingsN3Result> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('[n3/generate-embeddings] VOYAGE_API_KEY env var is not set');
  }

  // ── 1. Load items that need embedding ─────────────────────────────────────
  const allItems = await prisma.n3LineItem.findMany({
    where: { comparisonId },
    select: { id: true, normalizedDescription: true },
  });

  if (allItems.length === 0) {
    logger.warn('[n3/generate-embeddings] No items found — Phase 8 may not have run', {
      comparisonId,
    });
    return { totalRows: 0, embedded: 0, skipped: 0, batches: 0 };
  }

  // If not forcing, check which rows already have embeddings via raw SQL
  let itemsToEmbed = allItems;
  let skipped = 0;

  if (!force) {
    const existing = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM n3_line_items
      WHERE comparison_id = ${comparisonId}
        AND embedding IS NOT NULL
    `;
    const existingIds = new Set(existing.map(r => r.id));
    itemsToEmbed = allItems.filter(i => !existingIds.has(i.id));
    skipped = existingIds.size;
  }

  if (itemsToEmbed.length === 0) {
    logger.info('[n3/generate-embeddings] All items already embedded, skipping', {
      comparisonId,
      totalRows: allItems.length,
      skipped,
    });
    return { totalRows: allItems.length, embedded: 0, skipped, batches: 0 };
  }

  logger.info('[n3/generate-embeddings] Generating embeddings', {
    comparisonId,
    toEmbed: itemsToEmbed.length,
    skipped,
    model: VOYAGE_MODEL,
  });

  // ── 2. Call Voyage AI in batches ──────────────────────────────────────────
  let embedded = 0;
  let batches = 0;

  for (let i = 0; i < itemsToEmbed.length; i += BATCH_SIZE) {
    const batch = itemsToEmbed.slice(i, i + BATCH_SIZE);
    const texts = batch.map(item => item.normalizedDescription);

    const vectors = await callVoyageEmbeddings(texts, apiKey);

    // ── 3. Write vectors via raw SQL (Prisma can't write vector type) ────────
    await Promise.all(
      batch.map((item, idx) => {
        const vectorLiteral = `[${vectors[idx].join(',')}]`;
        return prisma.$executeRaw`
          UPDATE n3_line_items
          SET embedding = ${vectorLiteral}::vector
          WHERE id = ${item.id}
        `;
      }),
    );

    embedded += batch.length;
    batches++;

    logger.info('[n3/generate-embeddings] Batch complete', {
      comparisonId,
      batchNum: batches,
      batchSize: batch.length,
      totalEmbedded: embedded,
    });
  }

  logger.info('[n3/generate-embeddings] Embeddings complete', {
    comparisonId,
    totalRows: allItems.length,
    embedded,
    skipped,
    batches,
    model: VOYAGE_MODEL,
  });

  return { totalRows: allItems.length, embedded, skipped, batches };
}
