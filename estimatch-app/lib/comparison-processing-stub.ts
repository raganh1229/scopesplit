import { MatchStatus } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';

const DEFAULT_PROCESSING_STUB_DELAY_MS = 1500;

type ProcessingStubMode = 'success' | 'failed';

type RunProcessingStubOptions = {
  mode?: ProcessingStubMode;
  delayMs?: number;
};

function toNumber(value: number | bigint | { toString(): string } | null): number | null {
  if (value === null) return null;
  return Number(value);
}

function isModifiedStatus(status: MatchStatus): boolean {
  return status === MatchStatus.MODIFIED || status === MatchStatus.GROUPED;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRunComparisonProcessingStub(): boolean {
  const flag = process.env.ENABLE_COMPARISON_PROCESSING_STUB;

  if (flag === 'true') return true;
  if (flag === 'false') return false;

  return process.env.NODE_ENV !== 'production';
}

export async function runComparisonProcessingStub(
  comparisonId: string,
  options: RunProcessingStubOptions = {}
) {
  const mode = options.mode ?? 'success';
  const delayMs = options.delayMs ?? DEFAULT_PROCESSING_STUB_DELAY_MS;

  if (delayMs > 0) {
    await sleep(delayMs);
  }

  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      id: true,
      status: true,
      yourEstimateTotal: true,
      adjusterEstimateTotal: true,
      totalGap: true,
      matchCount: true,
      modifiedCount: true,
      missingCount: true,
      addedCount: true,
      lineItems: {
        select: {
          matchStatus: true,
          totalYours: true,
          totalAdjuster: true,
        },
      },
    },
  });

  if (!comparison) {
    throw new Error(`Comparison ${comparisonId} was not found.`);
  }

  if (mode === 'failed') {
    return prisma.comparison.update({
      where: { id: comparison.id },
      data: {
        status: 'FAILED',
        errorMessage: 'Processing stub marked this comparison as failed.',
      },
      select: {
        id: true,
        status: true,
      },
    });
  }

  const hasLineItems = comparison.lineItems.length > 0;

  let matchCount = comparison.matchCount;
  let modifiedCount = comparison.modifiedCount;
  let missingCount = comparison.missingCount;
  let addedCount = comparison.addedCount;
  let yourTotal = toNumber(comparison.yourEstimateTotal);
  let adjusterTotal = toNumber(comparison.adjusterEstimateTotal);
  let totalGap = toNumber(comparison.totalGap);

  if (hasLineItems) {
    matchCount = 0;
    modifiedCount = 0;
    missingCount = 0;
    addedCount = 0;
    yourTotal = 0;
    adjusterTotal = 0;

    for (const item of comparison.lineItems) {
      if (item.matchStatus === MatchStatus.MATCH) {
        matchCount += 1;
      } else if (item.matchStatus === MatchStatus.MISSING_FROM_ADJUSTER) {
        missingCount += 1;
      } else if (item.matchStatus === MatchStatus.ADDED_BY_ADJUSTER) {
        addedCount += 1;
      } else if (isModifiedStatus(item.matchStatus)) {
        modifiedCount += 1;
      }

      yourTotal += toNumber(item.totalYours) ?? 0;
      adjusterTotal += toNumber(item.totalAdjuster) ?? 0;
    }

    totalGap = yourTotal - adjusterTotal;
  }

  return prisma.comparison.update({
    where: { id: comparison.id },
    data: {
      status: 'COMPLETED',
      errorMessage: null,
      matchCount,
      modifiedCount,
      missingCount,
      addedCount,
      yourEstimateTotal: yourTotal,
      adjusterEstimateTotal: adjusterTotal,
      totalGap,
    },
    select: {
      id: true,
      status: true,
      updatedAt: true,
    },
  });
}
