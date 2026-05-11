/**
 * fetch-n3-results.ts
 *
 * Reads N3 pipeline results directly from the database (no auth required).
 * Outputs a JSON file in the shape compare.js expects:
 *   { comparison, zones, zoneReview, matchReview }
 *
 * Usage:
 *   npx tsx scripts/fetch-n3-results.ts --id <comparisonId> --out <filepath>
 */

import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import fs from 'fs';

dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

const args = process.argv.slice(2);
function arg(flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const comparisonId = arg('--id');
const outFile      = arg('--out');

if (!comparisonId || !outFile) {
  console.error('Usage: npx tsx scripts/fetch-n3-results.ts --id <comparisonId> --out <filepath>');
  process.exit(1);
}

// After the guard above both are non-null
const CID      = comparisonId as string;
const OUT_FILE = outFile      as string;

// ── MatchStatus enum → compare.js status string ──────────────────────────────
const MATCH_STATUS_MAP: Record<string, string> = {
  MATCH:                   'match',
  MODIFIED:                'modified',
  MISSING_FROM_ADJUSTER:   'missing',
  ADDED_BY_ADJUSTER:       'added',
  GROUPED:                 'modified',
};

// ── DB client (same pattern as run-n3-set.ts) ────────────────────────────────
const pool    = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

// ── Local types ───────────────────────────────────────────────────────────────
type AppItem = { status: string; your: { description: string; total: number } | null; adjuster: { description: string; total: number } | null };
type AppZone = { canonicalName: string; yourName: string | null; adjusterName: string | null; items: AppItem[] };

async function main() {
  try {
    // ── 1. Comparison base counts ─────────────────────────────────────────────
    const comp = await prisma.comparison.findUnique({
      where: { id: CID },
      select: { id: true, status: true, matchCount: true, modifiedCount: true, missingCount: true, addedCount: true },
    });
    if (!comp) { console.error(`Comparison ${CID} not found`); process.exit(1); }

    // ── 2. N3 zones (for zone detection shape) ────────────────────────────────
    const n3Zones = await prisma.n3Zone.findMany({
      where:  { comparisonId: CID },
      select: { id: true, source: true, name: true },
    });

    // ── 3. Zone correspondences (for zone pairing shape) ──────────────────────
    const corrRows = await prisma.n3ZoneCorrespondence.findMany({
      where:   { comparisonId: CID },
      include: {
        yourZones:     { select: { id: true, name: true } },
        adjusterZones: { select: { id: true, name: true } },
      },
    });

    // ── 3b. Build zone-name → canonical map from correspondences ─────────────
    // Ensures ADDED (adjuster-only) items use the same canonical zone name as
    // their contractor-zone counterparts, preventing duplicate zone groups.
    const zoneNameToCanonical = new Map<string, string>();
    for (const corr of corrRows) {
      const canonical = corr.yourZones[0]?.name ?? corr.adjusterZones[0]?.name ?? 'General';
      for (const z of corr.yourZones)     zoneNameToCanonical.set(z.name.toLowerCase(), canonical);
      for (const z of corr.adjusterZones) zoneNameToCanonical.set(z.name.toLowerCase(), canonical);
    }

    // ── 4. Line items — read matchStatus directly (set correctly by persist-decisions.ts)
    //    NOTE: Do NOT use n3_match_decisions.decisionType — those values are
    //    'one_to_one'/'unmatched'/'grouped', not the MATCH/MODIFIED enum values.
    const lineItems = await prisma.lineItem.findMany({
      where:  { comparisonId: CID },
      select: {
        matchStatus:         true,
        zoneCanonical:       true,
        zoneYours:           true,
        zoneAdjuster:        true,
        descriptionYours:    true,
        descriptionAdjuster: true,
        totalYours:          true,
        totalAdjuster:       true,
      },
      orderBy: { sortOrder: 'asc' },
    });

    // ── 5. Build compare.js zones structure ───────────────────────────────────
    const zoneMap = new Map<string, AppZone>();

    for (const li of lineItems) {
      const status       = MATCH_STATUS_MAP[li.matchStatus] ?? 'match';
      const yourZoneName  = li.zoneYours    ?? null;
      const adjZoneName   = li.zoneAdjuster ?? null;
      // Resolve canonical name via correspondence map so ADDED/MISSING items
      // share the same zone group as their paired zone partner.
      const lookupKey     = (yourZoneName ?? adjZoneName ?? '').toLowerCase();
      const canonicalName = zoneNameToCanonical.get(lookupKey)
        ?? li.zoneCanonical
        ?? yourZoneName
        ?? adjZoneName
        ?? 'General';

      if (!zoneMap.has(canonicalName)) {
        zoneMap.set(canonicalName, { canonicalName, yourName: yourZoneName, adjusterName: adjZoneName, items: [] });
      }
      const zone = zoneMap.get(canonicalName)!;
      if (!zone.yourName && yourZoneName)    zone.yourName     = yourZoneName;
      if (!zone.adjusterName && adjZoneName) zone.adjusterName = adjZoneName;

      zone.items.push({
        status,
        your:     li.descriptionYours    ? { description: li.descriptionYours,    total: li.totalYours?.toNumber()    ?? 0 } : null,
        adjuster: li.descriptionAdjuster ? { description: li.descriptionAdjuster, total: li.totalAdjuster?.toNumber() ?? 0 } : null,
      });
    }

    // ── 6. Zone detection shape ───────────────────────────────────────────────
    const zoneReview = {
      e1Zones: n3Zones.filter(z => z.source === 'yours').map(z => ({ name: z.name })),
      e2Zones: n3Zones.filter(z => z.source === 'adjuster').map(z => ({ name: z.name })),
    };

    // ── 7. Zone pairing shape ─────────────────────────────────────────────────
    const matchReview = {
      pairs: corrRows.map(c => ({
        e1Zones: c.yourZones.map(z => z.name),
        e2Zones: c.adjusterZones.map(z => z.name),
      })),
      unmatchedE1: [] as string[],
      unmatchedE2: [] as string[],
    };

    // ── 8. Write output ───────────────────────────────────────────────────────
    const output = {
      comparison: { id: comp.id, status: comp.status, matchCount: comp.matchCount, modifiedCount: comp.modifiedCount, missingCount: comp.missingCount, addedCount: comp.addedCount },
      zones:       [...zoneMap.values()],
      zoneReview,
      matchReview,
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`N3_RESULTS_FILE=${OUT_FILE}`);
    console.log(`  lineItems: ${lineItems.length}  zones: ${zoneMap.size}`);

  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
