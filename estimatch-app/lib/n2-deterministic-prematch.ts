/**
 * MOVED — this file has been relocated to lib/n2/n2-deterministic-prematch.ts.
 *
 * This stub re-exports everything from the canonical location so any future
 * imports of the old path continue to work during the transition period.
 * It will be deleted when N1 is retired (same cleanup commit as N1 code).
 *
 * Do NOT import N2ExtractedItem from this file — import from
 * @/lib/n2/schemas/types (canonical source of truth).
 */

export { runN2Prematch } from '@/lib/n2/n2-deterministic-prematch';

export type {
  N2ParsedItem,
  N2DeterministicMatch,
  N2PrematchResult,
  N2PrematchStats,
} from '@/lib/n2/n2-deterministic-prematch';
