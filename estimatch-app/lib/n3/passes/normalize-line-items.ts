// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 9: normalize-line-items
//
// Pure deterministic pass over all N3LineItem rows for a comparison. No LLM
// calls — all transformations are pure functions from normalization.ts plus
// keyword lookups defined here.
//
// Fields populated here (left null by Phase 8):
//   normalizedQuantity  — parseAmount(rawQuantity)
//   normalizedUnit      — expandUnit(rawUnit)
//   specialFlags        — detectSpecialFlags(rawDescription)
//   trade               — keyword lookup against the description
//   action              — keyword lookup against the description
//
// Fields already populated by Phase 8 (NOT touched here):
//   normalizedDescription, descriptionTokens, rawDescription, all amount fields,
//   itemCode, rawQuantity, rawUnit, page/source/zone metadata.
//
// material + object are intentionally left null — reserved for a possible
// future Sonnet-backed NLP pass if Phase 13 feature importance warrants it.
//
// Architecture refs: N3.md §Phase 9, §16.1 (feature inputs)
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import {
  parseAmount,
  expandUnit,
  detectSpecialFlags,
} from '@/lib/n3/normalization';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';

// ── Trade + action keyword maps ───────────────────────────────────────────────
// Lower-case substring matches against the raw description. First hit wins.
// Order matters: more specific patterns must come before more general ones
// (e.g. "remove and replace" before "remove").

// NOTE on ordering: more specific trades come FIRST. Patterns that appear
// in multiple trades (e.g. 'laminate' = floor OR countertop, 'underlayment'
// = floor OR roof) are tightened with a qualifier so they only match one trade.
const TRADE_KEYWORDS: Array<{ trade: string; patterns: string[] }> = [
  { trade: 'cabinetry',   patterns: ['cabinet', 'countertop', 'vanity', 'backsplash'] },
  { trade: 'drywall',     patterns: ['drywall', 'gypsum', 'sheetrock', 'cement board', 'backer board'] },
  { trade: 'painting',    patterns: ['paint', 'primer', 'texture', 'sealer'] },
  { trade: 'flooring',    patterns: ['carpet', 'hardwood', 'laminate floor', 'vinyl plank', 'tile floor', 'subfloor', 'floor underlayment', 'flooring', 'baseboard', 'base molding'] },
  { trade: 'electrical',  patterns: ['electrical', 'wiring', 'outlet', 'switch', 'breaker', 'circuit', 'light fixture', 'recessed', 'gfci', 'romex'] },
  { trade: 'plumbing',    patterns: ['plumb', 'pipe', 'drain', 'faucet', 'toilet', 'shower valve', 'p-trap', 'supply line'] },
  { trade: 'insulation',  patterns: ['insul', 'batt', 'fiberglass', 'cellulose', 'spray foam'] },
  { trade: 'doors_windows', patterns: ['window', 'door', 'casing', 'jamb', 'threshold', 'blinds', 'crown molding'] },
  { trade: 'roofing',     patterns: ['roof', 'shingle', 'roof underlayment', 'flashing', 'gutter', 'downspout', 'soffit', 'fascia'] },
  { trade: 'hvac',        patterns: ['hvac', 'furnace', 'duct', 'register', 'air handler', 'condenser'] },
  { trade: 'demolition',  patterns: ['demolition', 'debris', 'haul', 'dumpster', 'tear out', 'remove damaged', 'tear-out'] },
  { trade: 'cleaning',    patterns: ['clean', 'sanitize', 'deodorize', 'wipe down', 'final cleaning', 'post-construction cleaning'] },
  { trade: 'water_mit',   patterns: ['dehumidifier', 'air mover', 'lgr', 'water extraction', 'drying chamber', 'antimicrobial', 'mold inhibitor', 'moisture barrier', 'vapor barrier', 'content manipulation'] },
  { trade: 'tile',        patterns: ['ceramic tile', 'grout', 'thinset', 'mortar bed', 'tile'] },
  { trade: 'masonry',     patterns: ['concrete', 'masonry', 'brick', 'stucco'] },
];

const ACTION_KEYWORDS: Array<{ action: string; patterns: string[] }> = [
  // Multi-word patterns must come before their single-word constituents
  { action: 'remove_replace', patterns: ['remove and replace', 'r&r ', 'r & r ', 'r/r '] },
  { action: 'detach_reset',   patterns: ['detach and reset', 'detach & reset', 'd&r ', 'd & r '] },
  { action: 'remove',         patterns: ['remove ', 'tear out', 'demolish'] },
  { action: 'replace',        patterns: ['replace '] },
  { action: 'install',        patterns: ['install ', 'set ', 'mount '] },
  { action: 'repair',         patterns: ['repair ', 'patch '] },
  { action: 'paint',          patterns: ['paint ', 'prime ', 'seal '] },
  { action: 'clean',          patterns: ['clean ', 'sanitize', 'deodorize', 'wipe '] },
  { action: 'apply',          patterns: ['apply ', 'spray '] },
  { action: 'texture',        patterns: ['texture'] },
];

function classifyTrade(rawDescription: string): string | null {
  const lower = ' ' + rawDescription.toLowerCase() + ' ';
  for (const { trade, patterns } of TRADE_KEYWORDS) {
    for (const p of patterns) {
      if (lower.includes(p)) return trade;
    }
  }
  return null;
}

function classifyAction(rawDescription: string): string | null {
  const lower = ' ' + rawDescription.toLowerCase() + ' ';
  for (const { action, patterns } of ACTION_KEYWORDS) {
    for (const p of patterns) {
      if (lower.includes(p)) return action;
    }
  }
  return null;
}

// ── Return type ───────────────────────────────────────────────────────────────

export type NormalizeLineItemsN3Result = {
  totalRows: number;
  withQuantity: number;
  withUnit: number;
  withSpecialFlags: number;
  withTrade: number;
  withAction: number;
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Normalize all N3LineItem rows for a comparison.
 *
 * Idempotent: re-running on the same comparisonId is safe — every row is
 * recomputed from raw fields, so this can be replayed any time.
 *
 * Throws on unrecoverable error. The calling Inngest step will retry.
 */
export async function normalizeLineItemsN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<NormalizeLineItemsN3Result> {
  // ── 1. Load raw items ──────────────────────────────────────────────────────
  const items = await prisma.n3LineItem.findMany({
    where: { comparisonId },
    select: {
      id: true,
      rawDescription: true,
      rawQuantity: true,
      rawUnit: true,
    },
  });

  if (items.length === 0) {
    logger.warn('[n3/normalize-line-items] No items found — Phase 8 may not have run', { comparisonId });
    return { totalRows: 0, withQuantity: 0, withUnit: 0, withSpecialFlags: 0, withTrade: 0, withAction: 0 };
  }

  logger.info('[n3/normalize-line-items] Normalizing items', {
    comparisonId,
    totalItems: items.length,
  });

  // ── 2. Compute normalizations in memory ────────────────────────────────────
  type NormUpdate = {
    id: string;
    normalizedQuantity: number | null;
    normalizedUnit: string | null;
    specialFlags: string[];
    trade: string | null;
    action: string | null;
  };

  let withQuantity = 0;
  let withUnit = 0;
  let withSpecialFlags = 0;
  let withTrade = 0;
  let withAction = 0;

  const updates: NormUpdate[] = items.map(item => {
    const normalizedQuantity = parseAmount(item.rawQuantity);
    const normalizedUnit = expandUnit(item.rawUnit);
    const specialFlags = detectSpecialFlags(item.rawDescription);
    const trade = classifyTrade(item.rawDescription);
    const action = classifyAction(item.rawDescription);

    if (normalizedQuantity !== null) withQuantity++;
    if (normalizedUnit !== null) withUnit++;
    if (specialFlags.length > 0) withSpecialFlags++;
    if (trade !== null) withTrade++;
    if (action !== null) withAction++;

    return {
      id: item.id,
      normalizedQuantity,
      normalizedUnit,
      specialFlags,
      trade,
      action,
    };
  });

  // ── 3. Batch DB updates in parallel chunks ─────────────────────────────────
  // Normalization is idempotent so we don't need a transaction. Batching in
  // groups of 25 avoids hammering the connection pool and stays well within
  // Prisma's 5s interactive-transaction timeout.
  const BATCH_SIZE = 25;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(u =>
        prisma.n3LineItem.update({
          where: { id: u.id },
          data: {
            normalizedQuantity: u.normalizedQuantity,
            normalizedUnit: u.normalizedUnit,
            specialFlags: u.specialFlags,
            trade: u.trade,
            action: u.action,
          },
        }),
      ),
    );
  }

  logger.info('[n3/normalize-line-items] Normalization complete', {
    comparisonId,
    totalRows: items.length,
    withQuantity,
    withUnit,
    withSpecialFlags,
    withTrade,
    withAction,
  });

  return {
    totalRows: items.length,
    withQuantity,
    withUnit,
    withSpecialFlags,
    withTrade,
    withAction,
  };
}
