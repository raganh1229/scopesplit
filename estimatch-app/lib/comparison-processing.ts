import { MatchStatus } from '@/app/generated/prisma/client';
import { createHash } from 'node:crypto';
import pdfParse from 'pdf-parse';
import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';
import {
  runComparisonProcessingStub,
  shouldRunComparisonProcessingStub,
} from '@/lib/comparison-processing-stub';
import { filterExtractedLines } from '@/lib/comparison-line-filter';
import {
  runVisionPrematch,
  deterministicMatchesToRawLineItems,
  parseLineToFields,
  parseAllLinesWithZones,
  costsAllMatch,
  quantitiesEqual,
  isZoneCandidate,
} from '@/lib/deterministic-prematch';
import type { ParsedScopeFields } from '@/lib/deterministic-prematch';
import { reconcileZones, resolveCanonicalZone } from '@/lib/zone-reconciliation';
import type { ZoneReconciliationResult } from '@/lib/zone-reconciliation';
import { extractWithVision } from '@/lib/pdf-vision-extract';
import { traceReset, traceStep } from '@/lib/debug-trace';
import { writeStage, readStage, clearStage } from '@/lib/comparison-processing-state';

const ESTIMATES_BUCKET = 'estimates';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MAX_INPUT_TOKENS_PER_REQUEST = 160000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_TOKENS_OUTPUT = 64000;
const DEFAULT_MIN_MS_BETWEEN_ANTHROPIC_REQUESTS = 8000;
const DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS = 300000;
const DEFAULT_PROCESSING_CHUNK_TIMEOUT_MS = 600000;
const DEFAULT_PROCESSING_TOTAL_TIMEOUT_MS = 1800000;

type ProcessingTrigger = 'create-route' | 'manual-route';

type RunComparisonProcessingOptions = {
  trigger: ProcessingTrigger;
  stubMode?: 'success' | 'failed';
  stubDelayMs?: number;
};

type RawLineItem = {
  matchStatus?: unknown;
  zoneYours?: unknown;
  zoneAdjuster?: unknown;
  descriptionYours?: unknown;
  descriptionAdjuster?: unknown;
  qtyYours?: unknown;
  qtyAdjuster?: unknown;
  removeYours?: unknown;
  removeAdjuster?: unknown;
  replaceYours?: unknown;
  replaceAdjuster?: unknown;
  resetYours?: unknown;
  resetAdjuster?: unknown;
  taxYours?: unknown;
  taxAdjuster?: unknown;
  opYours?: unknown;
  opAdjuster?: unknown;
  totalYours?: unknown;
  totalAdjuster?: unknown;
  diffAmount?: unknown;
  category?: unknown;
  sortOrder?: unknown;
  groupId?: unknown;
  zoneCanonical?: unknown;
  zoneConfidence?: unknown;
};

type ParsedProcessingPayload = {
  lineItems: RawLineItem[];
};

type PersistableLineItem = {
  matchStatus: MatchStatus;
  zoneYours: string | null;
  zoneAdjuster: string | null;
  zoneCanonical: string | null;
  zoneConfidence: number | null;
  descriptionYours: string | null;
  descriptionAdjuster: string | null;
  qtyYours: string | null;
  qtyAdjuster: string | null;
  removeYours: number | null;
  removeAdjuster: number | null;
  replaceYours: number | null;
  replaceAdjuster: number | null;
  resetYours: number | null;
  resetAdjuster: number | null;
  taxYours: number | null;
  taxAdjuster: number | null;
  opYours: number | null;
  opAdjuster: number | null;
  totalYours: number | null;
  totalAdjuster: number | null;
  diffAmount: number | null;
  category: string | null;
  sortOrder: number;
  groupId: string | null;
};

type ExtractedLineRecord = {
  lineNumber: number;
  text: string;
};

type ComparisonChunk = {
  chunkIndex: number;
  yourStartLine: number;
  yourEndLine: number;
  adjusterStartLine: number;
  adjusterEndLine: number;
  yourLines: ExtractedLineRecord[];
  adjusterLines: ExtractedLineRecord[];
};

const MAX_CHUNK_SUBDIVISION_DEPTH = 6;
let lastAnthropicRequestAtMs = 0;

export function isRealProcessingEnabled(): boolean {
  return process.env.ENABLE_REAL_COMPARISON_PROCESSING === 'true';
}

export function isComparisonProcessingAvailable(): boolean {
  return isRealProcessingEnabled() || shouldRunComparisonProcessingStub();
}

function getAnthropicApiKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY;
  return key && key.trim().length > 0 ? key : null;
}

function getAnthropicModel(): string {
  const model = process.env.ANTHROPIC_MODEL;
  if (!model || model.trim().length === 0) {
    return DEFAULT_ANTHROPIC_MODEL;
  }

  return model.trim();
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const normalized = trimmed.replace(/[,$]/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toSortOrder(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return fallback;
}

function mapMatchStatus(value: unknown): MatchStatus {
  if (typeof value !== 'string') {
    return MatchStatus.MODIFIED;
  }

  const normalized = value.trim().toUpperCase();

  if (normalized === 'MATCH') return MatchStatus.MATCH;
  if (normalized === 'MISSING_FROM_ADJUSTER') return MatchStatus.MISSING_FROM_ADJUSTER;
  if (normalized === 'ADDED_BY_ADJUSTER') return MatchStatus.ADDED_BY_ADJUSTER;
  if (normalized === 'GROUPED') return MatchStatus.GROUPED;

  return MatchStatus.MODIFIED;
}

function extractJsonFromText(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    return fencedMatch[1].trim();
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }

  return text.trim();
}

function tryParseJson(text: string): unknown | null {
  const extractedJson = extractJsonFromText(text);

  if (!extractedJson) {
    return null;
  }

  try {
    return JSON.parse(extractedJson);
  } catch {
    return null;
  }
}

function ensurePayloadShape(payload: unknown): ParsedProcessingPayload {
  if (!payload || typeof payload !== 'object') {
    return { lineItems: [] };
  }

  const maybeLineItems = (payload as { lineItems?: unknown }).lineItems;
  if (!Array.isArray(maybeLineItems)) {
    return { lineItems: [] };
  }

  return {
    lineItems: maybeLineItems.filter((entry) => entry && typeof entry === 'object') as RawLineItem[],
  };
}

function normalizeLineItems(rawItems: RawLineItem[]): PersistableLineItem[] {
  return rawItems.map((item, index) => ({
    matchStatus: mapMatchStatus(item.matchStatus),
    zoneYours: toStringOrNull(item.zoneYours),
    zoneAdjuster: toStringOrNull(item.zoneAdjuster),
    zoneCanonical: toStringOrNull(item.zoneCanonical),
    zoneConfidence: toNumberOrNull(item.zoneConfidence),
    descriptionYours: toStringOrNull(item.descriptionYours),
    descriptionAdjuster: toStringOrNull(item.descriptionAdjuster),
    qtyYours: toStringOrNull(item.qtyYours),
    qtyAdjuster: toStringOrNull(item.qtyAdjuster),
    removeYours: toNumberOrNull(item.removeYours),
    removeAdjuster: toNumberOrNull(item.removeAdjuster),
    replaceYours: toNumberOrNull(item.replaceYours),
    replaceAdjuster: toNumberOrNull(item.replaceAdjuster),
    resetYours: toNumberOrNull(item.resetYours),
    resetAdjuster: toNumberOrNull(item.resetAdjuster),
    taxYours: toNumberOrNull(item.taxYours),
    taxAdjuster: toNumberOrNull(item.taxAdjuster),
    opYours: toNumberOrNull(item.opYours),
    opAdjuster: toNumberOrNull(item.opAdjuster),
    totalYours: toNumberOrNull(item.totalYours),
    totalAdjuster: toNumberOrNull(item.totalAdjuster),
    diffAmount: toNumberOrNull(item.diffAmount),
    category: toStringOrNull(item.category),
    sortOrder: toSortOrder(item.sortOrder, index),
    groupId: toStringOrNull(item.groupId),
  }));
}

function computeAggregates(lineItems: PersistableLineItem[]) {
  let yourEstimateTotal = 0;
  let adjusterEstimateTotal = 0;

  let matchCount = 0;
  let modifiedCount = 0;
  let missingCount = 0;
  let addedCount = 0;

  for (const item of lineItems) {
    if (item.matchStatus === MatchStatus.MATCH) matchCount += 1;
    else if (item.matchStatus === MatchStatus.MISSING_FROM_ADJUSTER) missingCount += 1;
    else if (item.matchStatus === MatchStatus.ADDED_BY_ADJUSTER) addedCount += 1;
    else modifiedCount += 1;

    yourEstimateTotal += item.totalYours ?? 0;
    adjusterEstimateTotal += item.totalAdjuster ?? 0;
  }

  return {
    yourEstimateTotal,
    adjusterEstimateTotal,
    totalGap: yourEstimateTotal - adjusterEstimateTotal,
    matchCount,
    modifiedCount,
    missingCount,
    addedCount,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getMaxInputTokensPerRequest(): number {
  const raw = process.env.MAX_COMPARISON_INPUT_TOKENS_PER_REQUEST;
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 2000) return Math.floor(parsed);
  return DEFAULT_MAX_INPUT_TOKENS_PER_REQUEST;
}

function getMaxRetries(): number {
  const raw = process.env.COMPARISON_PROCESSING_MAX_RETRIES;
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 8) return Math.floor(parsed);
  return DEFAULT_MAX_RETRIES;
}

function getMaxOutputTokensPerRequest(): number {
  const raw = process.env.MAX_COMPARISON_OUTPUT_TOKENS_PER_REQUEST;
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 500 && parsed <= 64000) return Math.floor(parsed);
  return DEFAULT_MAX_TOKENS_OUTPUT;
}

function getMinMsBetweenAnthropicRequests(): number {
  const raw = process.env.COMPARISON_PROCESSING_MIN_MS_BETWEEN_REQUESTS;
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 60000) return Math.floor(parsed);
  return DEFAULT_MIN_MS_BETWEEN_ANTHROPIC_REQUESTS;
}

function getAnthropicRequestTimeoutMs(): number {
  const raw = process.env.COMPARISON_PROCESSING_ANTHROPIC_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 15000 && parsed <= 300000) return Math.floor(parsed);
  return DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS;
}

function getProcessingTotalTimeoutMs(): number {
  const raw = process.env.COMPARISON_PROCESSING_TOTAL_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 120000 && parsed <= 3600000) return Math.floor(parsed);
  return DEFAULT_PROCESSING_TOTAL_TIMEOUT_MS;
}

function getProcessingChunkTimeoutMs(): number {
  const raw = process.env.COMPARISON_PROCESSING_CHUNK_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 30000 && parsed <= 900000) return Math.floor(parsed);
  return DEFAULT_PROCESSING_CHUNK_TIMEOUT_MS;
}

function elapsedSeconds(startedAtMs: number): string {
  return ((Date.now() - startedAtMs) / 1000).toFixed(1);
}

function isRateLimitMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('rate limit') ||
    normalized.includes('would exceed') ||
    normalized.includes('overloaded') ||
    normalized.includes('temporarily unavailable')
  );
}

function isRetryableAnthropicStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizePdfText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function toLineRecords(text: string): ExtractedLineRecord[] {
  const lines = text.split('\n');
  const records: ExtractedLineRecord[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) continue;
    records.push({
      lineNumber: i + 1,
      text: line,
    });
  }

  return records;
}

function formatLine(record: ExtractedLineRecord): string {
  return `${record.lineNumber}|${record.text}`;
}

function collectChunkLines(
  lines: ExtractedLineRecord[],
  startIndex: number,
  maxTokens: number
): { nextIndex: number; chunkLines: ExtractedLineRecord[] } {
  let cursor = startIndex;
  let usedTokens = 0;
  const chunkLines: ExtractedLineRecord[] = [];

  while (cursor < lines.length) {
    const candidate = lines[cursor];
    if (!candidate) break;

    const candidateTokens = estimateTokens(formatLine(candidate));
    if (chunkLines.length > 0 && usedTokens + candidateTokens > maxTokens) {
      break;
    }

    chunkLines.push(candidate);
    usedTokens += candidateTokens;
    cursor += 1;
  }

  return {
    nextIndex: cursor,
    chunkLines,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildChunks(
  yourLines: ExtractedLineRecord[],
  adjusterLines: ExtractedLineRecord[]
): ComparisonChunk[] {
  const perRequestBudget = getMaxInputTokensPerRequest();
  const perSideBudget = Math.max(1200, Math.floor(perRequestBudget * 0.40));

  const chunks: ComparisonChunk[] = [];
  let yourCursor = 0;
  let adjusterCursor = 0;
  let chunkIndex = 0;

  while (yourCursor < yourLines.length || adjusterCursor < adjusterLines.length) {
    const yourSlice = collectChunkLines(yourLines, yourCursor, perSideBudget);
    const adjusterSlice = collectChunkLines(adjusterLines, adjusterCursor, perSideBudget);

    if (yourSlice.chunkLines.length === 0 && adjusterSlice.chunkLines.length === 0) {
      break;
    }

    const yourStartLine = yourSlice.chunkLines[0]?.lineNumber ?? -1;
    const yourEndLine = yourSlice.chunkLines[yourSlice.chunkLines.length - 1]?.lineNumber ?? -1;
    const adjusterStartLine = adjusterSlice.chunkLines[0]?.lineNumber ?? -1;
    const adjusterEndLine =
      adjusterSlice.chunkLines[adjusterSlice.chunkLines.length - 1]?.lineNumber ?? -1;

    chunks.push({
      chunkIndex,
      yourStartLine,
      yourEndLine,
      adjusterStartLine,
      adjusterEndLine,
      yourLines: yourSlice.chunkLines,
      adjusterLines: adjusterSlice.chunkLines,
    });

    yourCursor = yourSlice.nextIndex;
    adjusterCursor = adjusterSlice.nextIndex;
    chunkIndex += 1;
  }

  return chunks;
}

function isJsonParseFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes('anthropic response was not valid json')
  );
}

function isTimeoutFailure(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('timed out');
}

function shouldSubdivideChunkOnFailure(error: unknown): boolean {
  return isJsonParseFailure(error) || isTimeoutFailure(error);
}

function splitLines(lines: ExtractedLineRecord[]): [ExtractedLineRecord[], ExtractedLineRecord[]] {
  if (lines.length <= 1) {
    return [lines, []];
  }

  const middle = Math.ceil(lines.length / 2);
  return [lines.slice(0, middle), lines.slice(middle)];
}

function withBounds(
  chunkIndex: number,
  yourLines: ExtractedLineRecord[],
  adjusterLines: ExtractedLineRecord[]
): ComparisonChunk {
  return {
    chunkIndex,
    yourStartLine: yourLines[0]?.lineNumber ?? -1,
    yourEndLine: yourLines[yourLines.length - 1]?.lineNumber ?? -1,
    adjusterStartLine: adjusterLines[0]?.lineNumber ?? -1,
    adjusterEndLine: adjusterLines[adjusterLines.length - 1]?.lineNumber ?? -1,
    yourLines,
    adjusterLines,
  };
}

function subdivideChunk(chunk: ComparisonChunk): ComparisonChunk[] {
  const [yourFirstHalf, yourSecondHalf] = splitLines(chunk.yourLines);
  const [adjusterFirstHalf, adjusterSecondHalf] = splitLines(chunk.adjusterLines);

  const children = [
    withBounds(chunk.chunkIndex * 10, yourFirstHalf, adjusterFirstHalf),
    withBounds(chunk.chunkIndex * 10 + 1, yourSecondHalf, adjusterSecondHalf),
  ].filter((child) => child.yourLines.length > 0 || child.adjusterLines.length > 0);

  return children;
}

type ChunkResult = {
  lineItems: RawLineItem[];
  zoneMappings: ClaudeZoneMapping[];
};

async function processChunkWithSubdivision(params: {
  chunk: ComparisonChunk;
  yourFilename: string;
  adjusterFilename: string;
  comparisonId: string;
  chunkLabel: string;
  abortSignal?: AbortSignal;
  depth?: number;
  yourParsedMap: Map<number, ParsedScopeFields>;
  adjParsedMap: Map<number, ParsedScopeFields>;
  skipZoneMappings?: boolean;
}): Promise<ChunkResult> {
  const depth = params.depth ?? 0;

  if (params.abortSignal?.aborted) {
    throw new Error(`Chunk ${params.chunkLabel} was canceled due to chunk timeout.`);
  }

  try {
    const payload = await callAnthropicForComparisonChunk({
      chunk: params.chunk,
      yourFilename: params.yourFilename,
      adjusterFilename: params.adjusterFilename,
      comparisonId: params.comparisonId,
      chunkLabel: params.chunkLabel,
      abortSignal: params.abortSignal,
      depth,
      yourParsedMap: params.yourParsedMap,
      adjParsedMap: params.adjParsedMap,
      skipZoneMappings: params.skipZoneMappings,
    });

    return { lineItems: payload.lineItems, zoneMappings: payload.zoneMappings ?? [] };
  } catch (error) {
    if (!shouldSubdivideChunkOnFailure(error) || depth >= MAX_CHUNK_SUBDIVISION_DEPTH) {
      throw error;
    }

    const children = subdivideChunk(params.chunk);
    if (children.length <= 1) {
      throw error;
    }

    const reason = isJsonParseFailure(error) ? 'JSON parse failure' : 'request timeout';
    console.log(
      `[comparison:${params.comparisonId}] Chunk ${params.chunkLabel} ${reason} at depth ${depth}; subdividing into ${children.length} child chunks.`
    );

    const recoveredLineItems: RawLineItem[] = [];
    const recoveredZoneMappings: ClaudeZoneMapping[] = [];

    for (const childChunk of children) {
      const childResult = await processChunkWithSubdivision({
        chunk: childChunk,
        yourFilename: params.yourFilename,
        adjusterFilename: params.adjusterFilename,
        comparisonId: params.comparisonId,
        chunkLabel: params.chunkLabel,
        abortSignal: params.abortSignal,
        depth: depth + 1,
        yourParsedMap: params.yourParsedMap,
        adjParsedMap: params.adjParsedMap,
        skipZoneMappings: params.skipZoneMappings,
      });
      recoveredLineItems.push(...childResult.lineItems);
      recoveredZoneMappings.push(...childResult.zoneMappings);
    }

    return { lineItems: recoveredLineItems, zoneMappings: recoveredZoneMappings };
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function parseResponseBody(
  response: Response
): Promise<{ payload: { error?: { message?: string }; content?: Array<{ type?: string; text?: string }> }; rawText: string }> {
  const responseText = await response.text();

  if (!responseText.trim()) {
    return { payload: {}, rawText: '' };
  }

  try {
    return {
      payload: JSON.parse(responseText) as {
        error?: { message?: string };
        content?: Array<{ type?: string; text?: string }>;
      },
      rawText: responseText,
    };
  } catch {
    return {
      payload: {},
      rawText: responseText,
    };
  }
}

function formatChunkElapsed(startedAtMs: number): string {
  return `${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`;
}

async function runWithTimeout<T>(params: {
  promise: Promise<T>;
  timeoutMs: number;
  timeoutMessage: string;
  onTimeout?: () => void;
}): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      params.onTimeout?.();
      reject(new Error(params.timeoutMessage));
    }, params.timeoutMs);
  });

  try {
    return await Promise.race([params.promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function callAnthropicWithRetry(
  body: object,
  context: {
    comparisonId: string;
    chunkLabel: string;
    operation: 'compare' | 'repair';
    abortSignal?: AbortSignal;
  }
) {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }

  let lastError = 'Anthropic request failed.';
  const maxRetries = getMaxRetries();

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (context.abortSignal?.aborted) {
      throw new Error(`Chunk ${context.chunkLabel} was canceled due to chunk timeout.`);
    }

    const attemptNumber = attempt + 1;
    const totalAttempts = maxRetries + 1;
    const minGapMs = getMinMsBetweenAnthropicRequests();
    const elapsedSinceLastRequest = Date.now() - lastAnthropicRequestAtMs;
    if (lastAnthropicRequestAtMs > 0 && elapsedSinceLastRequest < minGapMs) {
      const waitMs = minGapMs - elapsedSinceLastRequest;
      console.log(
        `[comparison:${context.comparisonId}] Chunk ${context.chunkLabel} ${context.operation} attempt ${attemptNumber}/${totalAttempts} waiting ${waitMs}ms for request pacing.`
      );
      await sleep(minGapMs - elapsedSinceLastRequest);
    }

    const timeoutMs = getAnthropicRequestTimeoutMs();
    const requestStartedAtMs = Date.now();
    console.log(
      `[comparison:${context.comparisonId}] Chunk ${context.chunkLabel} ${context.operation} attempt ${attemptNumber}/${totalAttempts} start (timeout=${timeoutMs}ms).`
    );
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
    };

    if (context.abortSignal) {
      context.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const timeoutHandle: ReturnType<typeof setTimeout> = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response: Response;

    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutHandle);
      lastAnthropicRequestAtMs = Date.now();

      const message =
        context.abortSignal?.aborted
          ? `Chunk ${context.chunkLabel} was canceled due to chunk timeout.`
          : error instanceof Error && error.name === 'AbortError'
          ? `Anthropic request timed out after ${timeoutMs}ms.`
          : error instanceof Error
            ? error.message
            : 'Anthropic request failed.';

      lastError = message;

      console.warn(
        `[comparison:${context.comparisonId}] Chunk ${context.chunkLabel} ${context.operation} attempt ${attemptNumber}/${totalAttempts} failed after ${formatChunkElapsed(requestStartedAtMs)}: ${message}`
      );

      if (attempt === maxRetries) {
        throw new Error(message);
      }

      const delayMs = Math.max(getMinMsBetweenAnthropicRequests(), 1000 * (attempt + 1) * 4);
      console.log(
        `[comparison:${context.comparisonId}] Chunk ${context.chunkLabel} ${context.operation} retrying in ${delayMs}ms.`
      );
      await sleep(delayMs);
      continue;
    } finally {
      clearTimeout(timeoutHandle);
      if (context.abortSignal) {
        context.abortSignal.removeEventListener('abort', onAbort);
      }
    }

    lastAnthropicRequestAtMs = Date.now();

    const { payload, rawText } = await parseResponseBody(response);

    if (response.ok) {
      console.log(
        `[comparison:${context.comparisonId}] Chunk ${context.chunkLabel} ${context.operation} attempt ${attemptNumber}/${totalAttempts} succeeded in ${formatChunkElapsed(requestStartedAtMs)}.`
      );
      return payload;
    }

    const message = payload.error?.message ?? rawText.slice(0, 300) ?? 'Anthropic request failed.';
    lastError = message;

    const shouldRetryForRateLimit =
      isRetryableAnthropicStatus(response.status) || isRateLimitMessage(message);

    if (!shouldRetryForRateLimit || attempt === maxRetries) {
      console.warn(
        `[comparison:${context.comparisonId}] Chunk ${context.chunkLabel} ${context.operation} attempt ${attemptNumber}/${totalAttempts} failed in ${formatChunkElapsed(requestStartedAtMs)} (status ${response.status}): ${message}`
      );
      throw new Error(message);
    }

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
    const isOverload = message.toLowerCase().includes('overloaded') || response.status === 529;
    const overloadBackoffMs = 15000 * (attempt + 1);
    const delayMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(1000, retryAfterSeconds * 1000)
      : isOverload
        ? Math.max(getMinMsBetweenAnthropicRequests(), overloadBackoffMs)
        : Math.max(getMinMsBetweenAnthropicRequests(), 1000 * (attempt + 1) * 4);

    console.warn(
      `[comparison:${context.comparisonId}] Chunk ${context.chunkLabel} ${context.operation} attempt ${attemptNumber}/${totalAttempts} retrying in ${delayMs}ms (status ${response.status}).`
    );

    await sleep(delayMs);
  }

  throw new Error(lastError);
}

async function downloadPdfBytes(storagePath: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);

  if (error || !data) {
    throw new Error(`Failed to download estimate PDF: ${error?.message ?? 'Unknown error'}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  const parsed = await pdfParse(pdfBytes);
  return normalizePdfText(parsed.text ?? '');
}

// ── Compact prompt helpers (description-only AI payload) ─────────────────────

type CompactPair = {
  y: number | null;
  a: number | null;
  zone: string | null;
};

type ClaudeZoneMapping = {
  yours: string | null;
  adjuster: string | null;
  canonical: string;
};

function extractZoneMappings(payload: unknown): ClaudeZoneMapping[] {
  if (!payload || typeof payload !== 'object') return [];
  const maybeZm = (payload as { zoneMappings?: unknown }).zoneMappings;
  if (!Array.isArray(maybeZm)) return [];
  return maybeZm
    .filter((z): z is Record<string, unknown> => z !== null && typeof z === 'object')
    .map((z) => ({
      yours: typeof z.yours === 'string' ? z.yours : null,
      adjuster: typeof z.adjuster === 'string' ? z.adjuster : null,
      canonical: typeof z.canonical === 'string' ? z.canonical : 'General',
    }))
    .filter((z) => z.yours !== null || z.adjuster !== null);
}

function formatCompactLine(
  record: ExtractedLineRecord,
  parsedMap: Map<number, ParsedScopeFields>
): string {
  let parsed = parsedMap.get(record.lineNumber);
  if (!parsed) {
    parsed = parseLineToFields(record);
  }
  const desc = parsed.description || record.text;
  const zone = parsed.zone ? `[${parsed.zone}]|` : '';
  const qtyUnit = parsed.quantity
    ? `|${parsed.quantity}${parsed.unit ? ' ' + parsed.unit : ''}`
    : '';
  const totalCost = parsed.costs.total !== null
    ? `|$${parsed.costs.total.toFixed(2)}`
    : '';
  return `${record.lineNumber}|${zone}${desc}${qtyUnit}${totalCost}`;
}

function formatLineForClaude(
  record: ExtractedLineRecord,
  parsedMap: Map<number, ParsedScopeFields>
): string {
  const parsed = parsedMap.get(record.lineNumber);
  if (!parsed) {
    // Not a scope item — check if it's a zone candidate
    if (isZoneCandidate(record.text)) {
      return `[ZONE?] ${record.text.trim()}`;
    }
    return ''; // skip non-scope, non-zone lines
  }
  return formatCompactLine(record, parsedMap);
}

function ensureCompactPairPayload(payload: unknown): CompactPair[] {
  if (!payload || typeof payload !== 'object') return [];

  const maybePairs = (payload as { pairs?: unknown }).pairs;
  if (!Array.isArray(maybePairs)) return [];

  return maybePairs
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
    .map((p) => ({
      y: typeof p.y === 'number' ? p.y : null,
      a: typeof p.a === 'number' ? p.a : null,
      zone: typeof p.zone === 'string' ? p.zone : null,
    }))
    .filter((p) => p.y !== null || p.a !== null);
}

function formatQtyWithUnit(parsed: ParsedScopeFields): string | null {
  if (!parsed.quantity) return null;
  return parsed.unit ? `${parsed.quantity} ${parsed.unit}` : parsed.quantity;
}

function buildRawLineItemFromParsed(
  matchStatus: string,
  yours: ParsedScopeFields | null,
  adj: ParsedScopeFields | null,
  sortOrder: number,
  claudeZone?: string | null
): RawLineItem {
  const yTotal = yours?.costs.total ?? null;
  const aTotal = adj?.costs.total ?? null;
  const diff =
    yTotal !== null && aTotal !== null
      ? Math.round((yTotal - aTotal) * 100) / 100
      : null;
  return {
    matchStatus,
    zoneYours: yours?.zone ?? null,
    zoneAdjuster: adj?.zone ?? null,
    descriptionYours: yours ? yours.description || yours.rawText : null,
    descriptionAdjuster: adj ? adj.description || adj.rawText : null,
    qtyYours: yours ? formatQtyWithUnit(yours) : null,
    qtyAdjuster: adj ? formatQtyWithUnit(adj) : null,
    removeYours: yours?.costs.remove ?? null,
    removeAdjuster: adj?.costs.remove ?? null,
    replaceYours: yours?.costs.replace ?? null,
    replaceAdjuster: adj?.costs.replace ?? null,
    resetYours: yours?.costs.reset ?? null,
    resetAdjuster: adj?.costs.reset ?? null,
    taxYours: yours?.costs.tax ?? null,
    taxAdjuster: adj?.costs.tax ?? null,
    opYours: yours?.costs.op ?? null,
    opAdjuster: adj?.costs.op ?? null,
    totalYours: yTotal,
    totalAdjuster: aTotal,
    diffAmount: diff,
    category: yours?.category ?? adj?.category ?? null,
    sortOrder,
    groupId: null,
    // Claude's zone assignment — used for canonical zone mapping
    zoneCanonical: claudeZone ?? yours?.zone ?? adj?.zone ?? 'General',
    zoneConfidence: claudeZone ? null : null,
  };
}

function resolveCompactPairsToRawItems(
  pairs: CompactPair[],
  yourParsedMap: Map<number, ParsedScopeFields>,
  adjParsedMap: Map<number, ParsedScopeFields>,
  chunkYourLines: ExtractedLineRecord[],
  chunkAdjLines: ExtractedLineRecord[]
): RawLineItem[] {
  const items: RawLineItem[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;

    // Look up parsed fields; fall back to on-the-fly parsing if not in map
    let yours: ParsedScopeFields | null = null;
    let adj: ParsedScopeFields | null = null;

    if (pair.y !== null) {
      yours = yourParsedMap.get(pair.y) ?? null;
      if (!yours) {
        const raw = chunkYourLines.find((l) => l.lineNumber === pair.y);
        if (raw) yours = parseLineToFields(raw);
      }
    }

    if (pair.a !== null) {
      adj = adjParsedMap.get(pair.a) ?? null;
      if (!adj) {
        const raw = chunkAdjLines.find((l) => l.lineNumber === pair.a);
        if (raw) adj = parseLineToFields(raw);
      }
    }

    let matchStatus: string;
    if (pair.y !== null && pair.a !== null) {
      // Both sides present — determine MATCH vs MODIFIED deterministically
      if (yours && adj) {
        const allCostsEqual = costsAllMatch(yours.costs, adj.costs);
        const qtyEqual = quantitiesEqual(yours.quantity, adj.quantity);
        matchStatus = allCostsEqual && qtyEqual ? 'MATCH' : 'MODIFIED';
      } else {
        matchStatus = 'MODIFIED'; // can't verify costs — safe default
      }
    } else if (pair.y !== null) {
      matchStatus = 'MISSING_FROM_ADJUSTER';
    } else {
      matchStatus = 'ADDED_BY_ADJUSTER';
    }

    items.push(buildRawLineItemFromParsed(matchStatus, yours, adj, i, pair.zone));
  }

  return items;
}

// ── Post-pair validation: split mispaired items ─────────────────────────────

/**
 * Stop-words that are too generic to count as meaningful overlap between
 * descriptions.  These appear in almost every Xactimate line item.
 */
const PAIR_STOP_WORDS = new Set([
  'r', 'rr', 'per', 'the', 'and', 'for', 'with', 'from', 'new', 'std',
  'standard', 'grade', 'coat', 'coats', '2', '1', '3', '4', 'ea', 'sf',
  'lf', 'sy', 'hr', 'day', 'inch', 'ft', 'replace', 'remove', 'install',
]);

/**
 * Tokenise a description into meaningful lowercase alpha-numeric tokens,
 * filtering out stop-words that are too generic to signal real overlap.
 */
function meaningfulTokens(desc: string | null): Set<string> {
  if (!desc) return new Set();
  const tokens = desc
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !PAIR_STOP_WORDS.has(t));
  return new Set(tokens);
}

/**
 * Scan MODIFIED items for pairs whose contractor and adjuster descriptions
 * share zero meaningful tokens.  Such pairs are almost certainly mispairs
 * (e.g. "Ceiling fan" ↔ "Smoke detector").  Split each bad pair into one
 * MISSING_FROM_ADJUSTER + one ADDED_BY_ADJUSTER.
 */
function splitZeroOverlapPairs(
  items: RawLineItem[],
  comparisonId: string
): RawLineItem[] {
  const result: RawLineItem[] = [];

  for (const item of items) {
    if (item.matchStatus !== 'MODIFIED') {
      result.push(item);
      continue;
    }

    const yDesc = typeof item.descriptionYours === 'string' ? item.descriptionYours : null;
    const aDesc = typeof item.descriptionAdjuster === 'string' ? item.descriptionAdjuster : null;
    const yTokens = meaningfulTokens(yDesc);
    const aTokens = meaningfulTokens(aDesc);

    // Count overlapping meaningful tokens
    let overlap = 0;
    for (const t of yTokens) {
      if (aTokens.has(t)) overlap++;
    }

    if (overlap === 0 && yTokens.size > 0 && aTokens.size > 0) {
      // Zero overlap — split into MISSING + ADDED
      console.warn(
        `[comparison:${comparisonId}] Splitting mispaired MODIFIED: ` +
          `"${(yDesc ?? '').substring(0, 40)}" ↔ ` +
          `"${(aDesc ?? '').substring(0, 40)}" — zero description overlap`
      );

      result.push({
        ...item,
        matchStatus: 'MISSING_FROM_ADJUSTER',
        descriptionAdjuster: null,
        qtyAdjuster: null,
        removeAdjuster: null,
        replaceAdjuster: null,
        resetAdjuster: null,
        taxAdjuster: null,
        opAdjuster: null,
        totalAdjuster: null,
        diffAmount: null,
      });

      const baseSort = typeof item.sortOrder === 'number' ? item.sortOrder : 0;
      result.push({
        ...item,
        matchStatus: 'ADDED_BY_ADJUSTER',
        descriptionYours: null,
        qtyYours: null,
        removeYours: null,
        replaceYours: null,
        resetYours: null,
        taxYours: null,
        opYours: null,
        totalYours: null,
        diffAmount: null,
        sortOrder: baseSort + 0.5,
      });
    } else {
      result.push(item);
    }
  }

  return result;
}

// ── Anthropic chunk processing ───────────────────────────────────────────────

async function callAnthropicForComparisonChunk(params: {
  chunk: ComparisonChunk;
  yourFilename: string;
  adjusterFilename: string;
  comparisonId: string;
  chunkLabel: string;
  abortSignal?: AbortSignal;
  depth: number;
  yourParsedMap: Map<number, ParsedScopeFields>;
  adjParsedMap: Map<number, ParsedScopeFields>;
  skipZoneMappings?: boolean;
}) {
  // Build Claude payload — scope items as numbered lines, zone candidates as [ZONE?]
  const yourClaudeLines = params.chunk.yourLines
    .map((r) => formatLineForClaude(r, params.yourParsedMap))
    .filter(Boolean);
  const adjusterClaudeLines = params.chunk.adjusterLines
    .map((r) => formatLineForClaude(r, params.adjParsedMap))
    .filter(Boolean);
  const yourCompactText = yourClaudeLines.join('\n');
  const adjusterCompactText = adjusterClaudeLines.join('\n');

  const yourHash = sha256(yourCompactText);
  const adjusterHash = sha256(adjusterCompactText);

  // Extract zone candidates from [ZONE?] markers in formatted lines
  const yourZoneCandidates = yourClaudeLines
    .filter(l => l.startsWith('[ZONE?]'))
    .map(l => l.replace('[ZONE?] ', '').trim());
  const adjZoneCandidates = adjusterClaudeLines
    .filter(l => l.startsWith('[ZONE?]'))
    .map(l => l.replace('[ZONE?] ', '').trim());

  const systemPrompt = [
    'You are an expert insurance estimate analyst specializing in Xactimate line-item matching and zone classification.',
    '',
    '═══════════════════════════════════════════════════════════════',
    'TASK OVERVIEW',
    '═══════════════════════════════════════════════════════════════',
    ...(params.skipZoneMappings ? [
      'You will receive line items from two Xactimate estimates (Contractor and Adjuster) for the same property damage claim.',
      'Every line item has a PRE-ASSIGNED ZONE shown in brackets, e.g. [Kitchen]. Zones have already been reconciled — both estimates use the SAME canonical zone names.',
      'Your ONLY job is to PAIR matching line items between the two estimates, strictly within each zone.',
    ] : [
      'You will receive line items from two Xactimate estimates (Contractor and Adjuster) for the same property damage claim.',
      'Items have NO pre-assigned zones. Lines are in DOCUMENT ORDER — the order they appear in the original PDF.',
      'Lines marked [ZONE?] are potential zone/room headers that appear between scope items.',
      'Your job is to:',
      '  1. IDENTIFY which [ZONE?] markers are real zone headers (rooms/areas) vs misidentified line items',
      '  2. ASSIGN every scope item to a zone based on which [ZONE?] header it falls under in document order',
      '  3. RECONCILE zone names across the two estimates (same room, different name)',
      '  4. PAIR matching line items between the two estimates',
    ]),
    '',
    '═══════════════════════════════════════════════════════════════',
    'DOMAIN CONTEXT',
    '═══════════════════════════════════════════════════════════════',
    '- Xactimate estimates contain scope-of-work line items grouped by zone/room (e.g., "Kitchen", "Master Bedroom", "Hall Bath", "Exterior / Windows").',
    '- Two independent estimators (contractor and adjuster) write separate estimates for the same property damage.',
    '- The same work item often appears with different wording, abbreviations, units, or prices.',
    '- The two estimates will almost NEVER have the same number of items. It is completely normal for one side to have items the other does not. Contractors often include work the adjuster excluded, and adjusters often add line items the contractor omitted. Unmatched items (y:null or a:null) are expected and correct — do NOT force-pair items just to reduce the unmatched count.',
    '- Different zones frequently contain structurally similar items (e.g., every room may have "ceiling drywall", "wall paint", "carpet").',
    '- Zone names between estimates may use different labels for the same room (e.g., "Living Area" vs "Living Room", "Bath" vs "Bathroom", "Exterior" vs "Exterior / Windows").',
    '',
    ...(params.skipZoneMappings ? [
      '═══════════════════════════════════════════════════════════════',
      'ZONE RULES — STRICTLY ENFORCED',
      '═══════════════════════════════════════════════════════════════',
      'Zone reconciliation has ALREADY been completed upstream. You must NOT perform any zone work.',
      '1. Every line item has a pre-assigned zone in brackets, e.g. [Kitchen]. This zone is FINAL and IMMUTABLE.',
      '2. Do NOT rename, merge, split, reclassify, or invent ANY zone names. The zones you see are the zones you use.',
      '3. Do NOT produce zoneMappings in your output. Zone reconciliation is not your responsibility.',
      '4. ONLY match items that share the SAME zone tag. If a contractor item is [Bedroom 1] and an adjuster item is [Bedroom 2], they CANNOT be paired even if the descriptions are identical.',
      '5. If a zone appears only in one estimate\'s items (e.g., all [Storage/Janitor] items are adjuster-only), every item in that zone must be emitted as unmatched (y:null or a:null).',
      '6. NEVER move an item from one zone to another. NEVER match across zones.',
    ] : [
      '═══════════════════════════════════════════════════════════════',
      'ZONE VALIDATION RULES',
      '═══════════════════════════════════════════════════════════════',
      '1. A [ZONE?] marker is a REAL zone header if it names a room, area, or section of a building (e.g., "Kitchen", "Hall Bath", "Exterior / Windows", "Roof", "General", "Living Room").',
      '2. A [ZONE?] marker is NOT a zone header if it describes a building component, material, or trade item (e.g., "Fascia", "Soffit", "Drywall", "Insulation", "Flashing"). These are line items that happen to start with a construction term.',
      '3. Zone headers NEVER have costs, quantities, or unit codes (SF, LF, EA). If a [ZONE?] line contains these, it is a line item, not a zone header.',
      '4. When in doubt, consider context: a real zone header typically groups 2+ related line items beneath it in the document.',
      '5. Items have NO pre-assigned zone. You MUST determine each item\'s zone from its position relative to [ZONE?] headers in the document.  Items appearing after a [ZONE?] header belong to that zone until the next [ZONE?] header appears.',
      '',
      '═══════════════════════════════════════════════════════════════',
      'ZONE RECONCILIATION RULES',
      '═══════════════════════════════════════════════════════════════',
      '1. Match zone names across the two estimates that refer to the same physical area (e.g., "Kitchen" ↔ "Kitchen / Dining", "Master Bath" ↔ "Primary Bathroom", "Exterior" ↔ "Exterior / Windows").',
      '2. Use a canonical name for each matched pair — prefer the clearer, more descriptive name.',
      '3. Zones that exist in only one estimate are valid — include them as unmatched in zoneMappings with null on the missing side.',
      '4. Numbered rooms are distinct: "Bedroom 1" ≠ "Bedroom 2".',
      '5. Never merge zones that refer to different physical spaces.',
    ]),
    '',
    '═══════════════════════════════════════════════════════════════',
    'ITEM MATCHING RULES (in priority order)',
    '═══════════════════════════════════════════════════════════════',
    ...(params.skipZoneMappings ? [
      '1. ZONE-STRICT MATCHING: ONLY match items that share the EXACT SAME zone tag. Never pair items from different zones, regardless of description similarity.',
      '2. DESCRIPTION SIMILARITY: Within the same zone, match items describing the same trade/work even with different wording (e.g., "R&R Base cabinets" ↔ "Remove & replace lower cabinets", "Tear out ceiling drywall" ↔ "Demo ceiling drywall").',
      '3. TOTAL COST AS CONFIRMING SIGNAL: If two items have similar descriptions AND similar total costs, they are very likely the same item. If descriptions are similar but costs are significantly different, they are likely still the same item with a pricing dispute — still match them.',
      '4. ONE-TO-ONE: Each line number must appear in exactly one pair. Never duplicate a line number across pairs.',
      '5. UNMATCHED ITEMS: If a line has no reasonable counterpart WITHIN ITS ZONE, emit it as unmatched (y:null or a:null). Do not force bad matches. Items must share meaningful trade/work keywords to be paired.',
      '6. NO CROSS-ZONE MATCHING: Cross-zone matching is FORBIDDEN. If item A is in [Kitchen] and item B is in [Living Room], they CANNOT be paired even if descriptions match perfectly.',
    ] : [
      '1. ZONE AWARENESS: Prefer matching items within the same or equivalent zone. Items with similar descriptions in different zones MAY be different work in different rooms.',
      '2. DESCRIPTION SIMILARITY: Match items describing the same trade/work even with different wording (e.g., "R&R Base cabinets" ↔ "Remove & replace lower cabinets", "Tear out ceiling drywall" ↔ "Demo ceiling drywall").',
      '3. TOTAL COST AS CONFIRMING SIGNAL: If two items have similar descriptions AND similar total costs, they are very likely the same item. If descriptions are similar but costs are significantly different, they are likely still the same item with a pricing dispute — still match them.',
      '4. ONE-TO-ONE: Each line number must appear in exactly one pair. Never duplicate a line number across pairs.',
      '5. UNMATCHED ITEMS: If a line has no reasonable counterpart, emit it as unmatched (y:null or a:null). Do not force bad matches. Two items that describe completely different work (e.g., "Ceiling fan" vs "Smoke detector", "Medicine cabinet" vs "Exhaust fan") must NEVER be paired, even if they are the only remaining unmatched items in the same zone. Items must share meaningful trade/work keywords to be paired.',
      '6. CROSS-ZONE MATCHING: Only match items across different zones if there is no reasonable in-zone candidate AND the descriptions are highly similar. This is acceptable but should be the exception.',
      '7. ZONE OVERRIDE: If a suggested zone assignment looks wrong (e.g., a window item assigned to "Hall Bath" when "Exterior / Windows" exists), assign the item to the correct zone in your output.',
    ]),
    '',
    '═══════════════════════════════════════════════════════════════',
    'COMMON XACTIMATE PATTERNS',
    '═══════════════════════════════════════════════════════════════',
    '- Abbreviations: R&R = Remove & Replace, SF = Square Feet, LF = Linear Feet, EA = Each, SY = Square Yard, CY = Cubic Yard',
    '- "Detach & reset" ≈ "R&R" for fixtures (faucets, light fixtures, etc.)',
    '- Description differences are normal: "Dumpster load - 20 yards" ↔ "Dumpster - debris removal"',
    '- Grade/finish differences are normal: "standard grade" ↔ "economy grade", "satin" ↔ "eggshell"',
    '- Category codes (RFG=Roofing, PLM=Plumbing, DRY=Drywall, PNT=Paint, FLR=Flooring, etc.) are informational context',
    '',
    '═══════════════════════════════════════════════════════════════',
    'CRITICAL ANTI-HALLUCINATION RULES',
    '═══════════════════════════════════════════════════════════════',
    ...(params.skipZoneMappings ? [
      '1. Do NOT create, invent, rename, merge, or modify ANY zone names. Zones are pre-assigned and FINAL.',
      '2. Do NOT produce zoneMappings. Zone reconciliation is not your responsibility.',
      '3. Every line number in your output MUST exist in the input. NEVER invent or fabricate line numbers.',
      '4. Do NOT add commentary, explanations, markdown formatting, or notes. Return ONLY the raw JSON object specified below.',
      '5. Do NOT wrap the JSON in ```json``` code fences or any other formatting.',
    ] : [
      '1. You must ONLY use zone names that ALREADY EXIST in the input text — from [ZONE?] markers or from the "All detected zones" context list. Do NOT invent, fabricate, or infer zone names that do not appear in the provided data.',
      '2. Every line number in your output MUST exist in the input. NEVER invent or fabricate line numbers.',
      '3. Every canonical zone name in zoneMappings MUST come from an actual zone name present in the input. Do not create new names by combining or paraphrasing zone names.',
      '4. If you are unsure about a zone assignment, assign to "General" rather than guessing.',
      '5. Do NOT add commentary, explanations, markdown formatting, or notes. Return ONLY the raw JSON object specified below.',
      '6. Do NOT wrap the JSON in ```json``` code fences or any other formatting.',
    ]),
    '',
    '═══════════════════════════════════════════════════════════════',
    'INPUT FORMAT',
    '═══════════════════════════════════════════════════════════════',
    ...(params.skipZoneMappings ? [
      'Scope line items: lineNumber|[Zone Name]|description|quantity unit|$totalCost',
      'The [Zone Name] bracket is the pre-assigned canonical zone for that item. Use it to constrain matching.',
    ] : [
      'Scope line items: lineNumber|description|quantity unit|$totalCost',
      'Zone candidates: [ZONE?] ZoneName',
    ]),
    '',
    '═══════════════════════════════════════════════════════════════',
    'OUTPUT FORMAT',
    '═══════════════════════════════════════════════════════════════',
    'Return ONLY this JSON structure — nothing else:',
    ...(params.skipZoneMappings ? [
      '{',
      '  "pairs": [',
      '    {"y": lineNumber|null, "a": lineNumber|null}',
      '  ]',
      '}',
      '',
      'FIELD DEFINITIONS:',
      '- pairs: Array of ALL line items. "y" = contractor line number (or null if adjuster-only), "a" = adjuster line number (or null if contractor-only).',
    ] : [
      '{',
      '  "zoneMappings": [',
      '    {"yours": "contractor zone name", "adjuster": "adjuster zone name", "canonical": "preferred display name"},',
      '    {"yours": "contractor-only zone", "adjuster": null, "canonical": "display name"},',
      '    {"yours": null, "adjuster": "adjuster-only zone", "canonical": "display name"}',
      '  ],',
      '  "pairs": [',
      '    {"y": lineNumber|null, "a": lineNumber|null, "zone": "canonical zone name"}',
      '  ]',
      '}',
      '',
      'FIELD DEFINITIONS:',
      '- zoneMappings: Array of all zone pairs/singletons. "yours" = contractor zone name (or null), "adjuster" = adjuster zone name (or null), "canonical" = the display name to use.',
      '- pairs: Array of ALL line items. "y" = contractor line number (or null if adjuster-only), "a" = adjuster line number (or null if contractor-only), "zone" = the canonical zone this item belongs to.',
    ]),
    '- Every input line number must appear exactly once across all pairs.',
    '- [ZONE?] markers should NOT appear in pairs — they are zone headers, not line items (unless you determined they are actually line items, in which case treat them as scope items).',
  ].join('\n');

  // Build zone context for Claude — zone candidates detected in this chunk
  const zoneContext = [
    `Zone candidates detected (contractor): ${yourZoneCandidates.join(', ') || '[none]'}`,
    `Zone candidates detected (adjuster): ${adjZoneCandidates.join(', ') || '[none]'}`,
  ].join('\n');

  traceStep('SONNET 2 (ITEM PAIRING) — INPUT', `SYSTEM PROMPT:\n${systemPrompt}\n\nCONTRACTOR LINES:\n${yourCompactText || '[none]'}\n\nADJUSTER LINES:\n${adjusterCompactText || '[none]'}`);

  const payload = await callAnthropicWithRetry({
    model: getAnthropicModel(),
    max_tokens: getMaxOutputTokensPerRequest(),
    temperature: 0,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: params.skipZoneMappings
              ? `Pair matching line items between these two Xactimate estimates. Every item has a PRE-ASSIGNED ZONE in brackets (e.g. [Kitchen]). Zones are already reconciled — both estimates use the same canonical zone names.\n\nEach scope line is formatted as: lineNumber|[Zone Name]|description|quantity unit|$totalCost\n\nRules:\n- ONLY match items within the SAME zone. Cross-zone matching is FORBIDDEN.\n- If a zone exists only in one estimate's items, emit every item in that zone as unmatched (y:null or a:null).\n- Do NOT rename, merge, invent, or modify zone names. Zones are FINAL.\n- Pair items by description similarity within zone. Use total cost as a confirming signal.\n- Every input line number must appear exactly once in the output pairs.\n- NEVER invent line numbers.\n- Return RAW JSON only — no markdown fences, no commentary.`
              : `Analyze these two Xactimate estimate sections. Items are in DOCUMENT ORDER with NO pre-assigned zones. Identify zone headers from [ZONE?] markers, assign every item to a zone, reconcile zones across estimates, and pair matching items.\n\nEach scope line is formatted as: lineNumber|description|quantity unit|$totalCost\nZone candidate markers appear as: [ZONE?] ZoneName — items below a [ZONE?] marker belong to that zone until the next marker.\n\n${zoneContext}\n\nRemember:\n- Identify [ZONE?] markers: real zone headers name rooms/areas (Kitchen, Bedroom, Exterior), NOT building components (Fascia, Soffit, Drywall).\n- Assign zones: each scope item belongs to the nearest [ZONE?] header ABOVE it in document order.\n- Reconcile zones: map contractor zones to adjuster zones where they refer to the same physical space.\n- Pair items: prefer same-zone matches, use description + total cost as signals.\n- Every input line number must appear exactly once in the output pairs.\n- NEVER invent line numbers or zone names that do not exist in the input.\n- Return RAW JSON only, no markdown fences, no commentary.`,
          },
          {
            type: 'text',
            text: `Chunk index: ${params.chunk.chunkIndex}`,
          },
          {
            type: 'text',
            text: `Contractor (${params.yourFilename}), sha256 ${yourHash}:\n${yourCompactText || '[none]'}`,
          },
          {
            type: 'text',
            text: `Adjuster (${params.adjusterFilename}), sha256 ${adjusterHash}:\n${adjusterCompactText || '[none]'}`,
          },
        ],
      },
    ],
  }, {

    comparisonId: params.comparisonId,
    chunkLabel: `${params.chunkLabel}/d${params.depth}`,
    operation: 'compare',
    abortSignal: params.abortSignal,
  });

  const combinedText = (payload.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');

  traceStep('SONNET 2 (ITEM PAIRING) — RAW RESPONSE', combinedText);

  const compareStopReason =
    (payload as { stop_reason?: string | null }).stop_reason ?? null;

  if (!combinedText.trim()) {
    throw new Error('Anthropic response did not include text content.');
  }

  let parsed = tryParseJson(combinedText);

  if (!parsed) {
    console.warn(
      `[comparison:${params.comparisonId}] Chunk ${params.chunkLabel}/d${params.depth} compare output was not parseable JSON (stop_reason=${compareStopReason ?? 'unknown'}, chars=${combinedText.length}). Attempting repair.`
    );

    const repairMaxTokens = Math.max(
      1200,
      Math.min(6000, getMaxOutputTokensPerRequest() * 2)
    );

    const repairPayload = await callAnthropicWithRetry({
      model: getAnthropicModel(),
      max_tokens: repairMaxTokens,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Convert the following assistant output into valid JSON ONLY. Do not summarize, do not add commentary, do not drop fields. Return a single JSON object.',
            },
            {
              type: 'text',
              text: combinedText.slice(0, 24000),
            },
          ],
        },
      ],
    }, {
      comparisonId: params.comparisonId,
      chunkLabel: `${params.chunkLabel}/d${params.depth}`,
      operation: 'repair',
      abortSignal: params.abortSignal,
    });

    const repairedText = (repairPayload.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');

    const repairStopReason =
      (repairPayload as { stop_reason?: string | null }).stop_reason ?? null;

    parsed = tryParseJson(repairedText);

    if (!parsed) {
      console.warn(
        `[comparison:${params.comparisonId}] Chunk ${params.chunkLabel}/d${params.depth} repair output was not parseable JSON (stop_reason=${repairStopReason ?? 'unknown'}, chars=${repairedText.length}, repairMaxTokens=${repairMaxTokens}).`
      );
    }
  }

  if (!parsed) {
    const excerpt = combinedText.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Anthropic response was not valid JSON. Excerpt: ${excerpt}`);
  }

  // Try compact pair format first (new prompt response)
  const compactPairs = ensureCompactPairPayload(parsed);
  const zoneMappings = extractZoneMappings(parsed);

  if (zoneMappings.length > 0) {
    console.log(
      `[comparison:${params.comparisonId}] Chunk ${params.chunkLabel}/d${params.depth} returned ${zoneMappings.length} zone mappings from Claude.`
    );
  }

  if (compactPairs.length > 0) {
    const resolvedItems = resolveCompactPairsToRawItems(
      compactPairs,
      params.yourParsedMap,
      params.adjParsedMap,
      params.chunk.yourLines,
      params.chunk.adjusterLines
    );

    // Post-pair validation: split MODIFIED pairs with zero description overlap
    const validated = splitZeroOverlapPairs(resolvedItems, params.comparisonId);

    return { lineItems: validated, zoneMappings };
  }

  // Fall back to legacy format (Claude returned lineItems instead of pairs)
  console.warn(
    `[comparison:${params.comparisonId}] Chunk ${params.chunkLabel}/d${params.depth} returned legacy format — using lineItems directly.`
  );
  const legacy = ensurePayloadShape(parsed);
  return { ...legacy, zoneMappings };
}

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE STAGES (N1 multi-step refactor — Phase 3)
// ═══════════════════════════════════════════════════════════════════════════
// runRealProcessing decomposed into 4 stages (A→B→C→D). Stage I/O is JSON-
// serializable (Maps as Array<[k,v]>) so Phase 4 can store outputs in the
// comparison_processing_state table without changing data shapes.
// All four stages are exported for Phase 6 (Inngest) to wire as step handlers.
// IMPORTANT: behavior-preserving copy-paste from original runRealProcessing.

type ExtractedState = {
  useVisionExtraction: boolean;
  yourEstimateFilename: string;
  adjusterEstimateFilename: string;
  linesToChunkYours: ExtractedLineRecord[];
  linesToChunkAdjuster: ExtractedLineRecord[];
  yourParsedMapEntries: Array<[number, ParsedScopeFields]>;
  adjParsedMapEntries: Array<[number, ParsedScopeFields]>;
  yourZonesWithCounts: Array<{ name: string; count: number }>;
  adjZonesWithCounts: Array<{ name: string; count: number }>;
  visionYourParsedMapEntries: Array<[number, ParsedScopeFields]> | null;
  visionAdjParsedMapEntries: Array<[number, ParsedScopeFields]> | null;
};

type SerializedZoneReconciliation = {
  pairs: ZoneReconciliationResult['pairs'];
  unmatchedYours: string[];
  unmatchedAdjuster: string[];
  zoneMapEntries: Array<[string, { canonical: string; confidence: number }]>;
  skipped: boolean;
};

type PrematchedState = {
  useVisionExtraction: boolean;
  yourEstimateFilename: string;
  adjusterEstimateFilename: string;
  linesToChunkYours: ExtractedLineRecord[];
  linesToChunkAdjuster: ExtractedLineRecord[];
  yourParsedMapEntries: Array<[number, ParsedScopeFields]>;
  adjParsedMapEntries: Array<[number, ParsedScopeFields]>;
  prematchRawItems: RawLineItem[];
  visionZoneReconciliation: SerializedZoneReconciliation | null;
};

type PairedState = {
  useVisionExtraction: boolean;
  rawLineItems: RawLineItem[];
  allClaudeZoneMappings: ClaudeZoneMapping[];
  // Carry-forward fields from PrematchedState that Stage D consumes. Pair-
  // stage's wrapper copies these from the `prematched` state row before
  // writing the `paired` row, so Stage D can read a single state row and
  // still have everything it needs.
  prematchRawItems: RawLineItem[];
  visionZoneReconciliation: SerializedZoneReconciliation | null;
};

type FinalResult = {
  mode: 'real';
  status: 'COMPLETED';
  lineItemCount: number;
};

// ── Stage A: PDF download + extraction ─────────────────────────────────────
//
// The exported `extractStage` is a thin wrapper around `extractStageImpl`
// that persists the result to the comparison_processing_state table
// (Phase 4 wiring). Inngest will invoke `extractStage` as `step.run('extract',
// () => extractStage(id))` in Phase 6.

export async function extractStage(comparisonId: string): Promise<ExtractedState> {
  const extracted = await extractStageImpl(comparisonId);
  await writeStage(comparisonId, 'extracted', extracted);
  return extracted;
}

async function extractStageImpl(comparisonId: string): Promise<ExtractedState> {
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      id: true,
      yourEstimateFilename: true,
      adjusterEstimateFilename: true,
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });
  if (!comparison) throw new Error(`Comparison ${comparisonId} not found.`);

  const yourPdfBytes = await downloadPdfBytes(comparison.yourEstimateStoragePath);
  const adjusterPdfBytes = await downloadPdfBytes(comparison.adjusterEstimateStoragePath);

  const useVisionExtraction = process.env.ENABLE_VISION_EXTRACTION === 'true';
  traceReset();

  if (useVisionExtraction) {
    console.log(`[comparison:${comparisonId}] Using Haiku vision extraction...`);
    const [yourVision, adjVision] = await Promise.all([
      extractWithVision(yourPdfBytes, { comparisonId, side: 'yours' }),
      extractWithVision(adjusterPdfBytes, { comparisonId, side: 'adjuster' }),
    ]);
    console.log(
      `[comparison:${comparisonId}] Vision extraction complete — yours: ${yourVision.lines.length} items, adjuster: ${adjVision.lines.length} items`
    );

    const yourZoneCounts = new Map<string, number>();
    for (const p of yourVision.parsedMap.values()) {
      if (p.zone && p.zone.length > 0) yourZoneCounts.set(p.zone, (yourZoneCounts.get(p.zone) ?? 0) + 1);
    }
    const adjZoneCounts = new Map<string, number>();
    for (const p of adjVision.parsedMap.values()) {
      if (p.zone && p.zone.length > 0) adjZoneCounts.set(p.zone, (adjZoneCounts.get(p.zone) ?? 0) + 1);
    }
    const yourZonesWithCounts = [...yourZoneCounts.entries()].map(([name, count]) => ({ name, count }));
    const adjZonesWithCounts = [...adjZoneCounts.entries()].map(([name, count]) => ({ name, count }));

    console.log(
      `[comparison:${comparisonId}] Zones detected (raw) — yours: [${yourZonesWithCounts.map(z => `${z.name}(${z.count})`).join(', ')}], adjuster: [${adjZonesWithCounts.map(z => `${z.name}(${z.count})`).join(', ')}]`
    );

    return {
      useVisionExtraction: true,
      yourEstimateFilename: comparison.yourEstimateFilename,
      adjusterEstimateFilename: comparison.adjusterEstimateFilename,
      linesToChunkYours: [],
      linesToChunkAdjuster: [],
      yourParsedMapEntries: [],
      adjParsedMapEntries: [],
      yourZonesWithCounts,
      adjZonesWithCounts,
      visionYourParsedMapEntries: [...yourVision.parsedMap.entries()],
      visionAdjParsedMapEntries: [...adjVision.parsedMap.entries()],
    };
  }

  // Legacy extraction
  const yourText = await extractPdfText(yourPdfBytes);
  const adjusterText = await extractPdfText(adjusterPdfBytes);
  const yourLineRecordsRaw = toLineRecords(yourText);
  const adjusterLineRecordsRaw = toLineRecords(adjusterText);
  const yourFiltered = filterExtractedLines(yourLineRecordsRaw);
  const adjusterFiltered = filterExtractedLines(adjusterLineRecordsRaw);

  console.log(
    `[comparison:${comparisonId}] Pre-filter (yours): ${yourFiltered.stats.inputCount} → ${yourFiltered.stats.outputCount} lines, ~${yourFiltered.stats.estimatedTokensSaved} tokens saved (chrome:${yourFiltered.stats.droppedPageChrome} meta:${yourFiltered.stats.droppedMetadata} boiler:${yourFiltered.stats.droppedBoilerplate} summary:${yourFiltered.stats.droppedSummaryLines} dup:${yourFiltered.stats.droppedDuplicates})`
  );
  console.log(
    `[comparison:${comparisonId}] Pre-filter (adjuster): ${adjusterFiltered.stats.inputCount} → ${adjusterFiltered.stats.outputCount} lines, ~${adjusterFiltered.stats.estimatedTokensSaved} tokens saved (chrome:${adjusterFiltered.stats.droppedPageChrome} meta:${adjusterFiltered.stats.droppedMetadata} boiler:${adjusterFiltered.stats.droppedBoilerplate} summary:${adjusterFiltered.stats.droppedSummaryLines} dup:${adjusterFiltered.stats.droppedDuplicates})`
  );

  const yourParsedMap = parseAllLinesWithZones(yourFiltered.lines, yourLineRecordsRaw);
  const adjParsedMap = parseAllLinesWithZones(adjusterFiltered.lines, adjusterLineRecordsRaw);

  return {
    useVisionExtraction: false,
    yourEstimateFilename: comparison.yourEstimateFilename,
    adjusterEstimateFilename: comparison.adjusterEstimateFilename,
    linesToChunkYours: yourFiltered.lines,
    linesToChunkAdjuster: adjusterFiltered.lines,
    yourParsedMapEntries: [...yourParsedMap.entries()],
    adjParsedMapEntries: [...adjParsedMap.entries()],
    yourZonesWithCounts: [],
    adjZonesWithCounts: [],
    visionYourParsedMapEntries: null,
    visionAdjParsedMapEntries: null,
  };
}

// ── Stage B: Zone reconciliation + deterministic prematch (vision only) ────
//
// Wrapper reads the `extracted` payload written by Stage A, runs the impl,
// and persists the resulting `prematched` payload.

export async function reconcileAndPrematchStage(
  comparisonId: string,
): Promise<PrematchedState> {
  const extracted = await readStage<ExtractedState>(comparisonId, 'extracted');
  if (!extracted) {
    throw new Error(
      `reconcileAndPrematchStage: no 'extracted' state found for comparison ${comparisonId} — Stage A must run first.`
    );
  }
  const prematched = await reconcileAndPrematchStageImpl(comparisonId, extracted);
  await writeStage(comparisonId, 'prematched', prematched);
  return prematched;
}

async function reconcileAndPrematchStageImpl(
  comparisonId: string,
  extracted: ExtractedState,
): Promise<PrematchedState> {
  if (!extracted.useVisionExtraction) {
    return {
      useVisionExtraction: false,
      yourEstimateFilename: extracted.yourEstimateFilename,
      adjusterEstimateFilename: extracted.adjusterEstimateFilename,
      linesToChunkYours: extracted.linesToChunkYours,
      linesToChunkAdjuster: extracted.linesToChunkAdjuster,
      yourParsedMapEntries: extracted.yourParsedMapEntries,
      adjParsedMapEntries: extracted.adjParsedMapEntries,
      prematchRawItems: [],
      visionZoneReconciliation: null,
    };
  }

  if (!extracted.visionYourParsedMapEntries || !extracted.visionAdjParsedMapEntries) {
    throw new Error('Vision mode but vision parsed maps missing from extracted state.');
  }
  const yourVisionParsedMap = new Map(extracted.visionYourParsedMapEntries);
  const adjVisionParsedMap = new Map(extracted.visionAdjParsedMapEntries);
  const yourDeduped = extracted.yourZonesWithCounts;
  const adjDeduped = extracted.adjZonesWithCounts;

  traceStep('PRE-DEDUP (DISABLED)', [
    'YOURS ZONES (raw from Haiku):',
    ...extracted.yourZonesWithCounts.map(z => `  ${z.count}x  ${z.name}`),
    '',
    'ADJUSTER ZONES (raw from Haiku):',
    ...extracted.adjZonesWithCounts.map(z => `  ${z.count}x  ${z.name}`),
    '',
    'PRE-DEDUP: disabled — passing raw zones directly to Sonnet 1',
  ].join('\n'));

  let visionZoneReconciliationResult: ZoneReconciliationResult;
  try {
    visionZoneReconciliationResult = await reconcileZones(yourDeduped, adjDeduped, comparisonId);
  } catch (zoneError) {
    console.warn(
      `[comparison:${comparisonId}] Zone reconciliation failed, using raw zone names: ${zoneError instanceof Error ? zoneError.message : 'Unknown'}`
    );
    const fallbackMap = new Map<string, { canonical: string; confidence: number }>();
    const yourDedupedNames = yourDeduped.map(z => z.name);
    const adjDedupedNames = adjDeduped.map(z => z.name);
    for (const z of yourDedupedNames) fallbackMap.set(z.toLowerCase(), { canonical: z, confidence: 0 });
    for (const z of adjDedupedNames) fallbackMap.set(z.toLowerCase(), { canonical: z, confidence: 0 });
    visionZoneReconciliationResult = { pairs: [], unmatchedYours: yourDedupedNames, unmatchedAdjuster: adjDedupedNames, zoneMap: fallbackMap, skipped: true };
  }

  const yourParsedWithCanonical: ParsedScopeFields[] = [];
  for (const [, parsed] of yourVisionParsedMap) {
    const rawZone = parsed.zone;
    const entry = rawZone ? visionZoneReconciliationResult.zoneMap.get(rawZone.toLowerCase()) : null;
    yourParsedWithCanonical.push({ ...parsed, zone: entry ? entry.canonical : (rawZone ?? 'General') });
  }
  const adjParsedWithCanonical: ParsedScopeFields[] = [];
  for (const [, parsed] of adjVisionParsedMap) {
    const rawZone = parsed.zone;
    const entry = rawZone ? visionZoneReconciliationResult.zoneMap.get(rawZone.toLowerCase()) : null;
    adjParsedWithCanonical.push({ ...parsed, zone: entry ? entry.canonical : (rawZone ?? 'General') });
  }

  const prematchResult = runVisionPrematch(yourParsedWithCanonical, adjParsedWithCanonical);

  console.log(
    `[comparison:${comparisonId}] Vision prematch: ${prematchResult.stats.autoMatchedCount} matched ` +
      `(${prematchResult.stats.exactMatchCount} exact, ${prematchResult.stats.modifiedMatchCount} modified), ` +
      `${prematchResult.stats.unmatchedYoursCount} yours unmatched, ${prematchResult.stats.unmatchedAdjusterCount} adjuster unmatched, ` +
      `avg confidence: ${prematchResult.stats.avgConfidence}`
  );

  {
    const s = prematchResult.stats;
    const traceLines: string[] = [
      'PREMATCH STATS',
      `  Total matched:      ${s.autoMatchedCount}`,
      `    Exact (MATCH):    ${s.exactMatchCount}`,
      `    Modified:         ${s.modifiedMatchCount}`,
      `  Yours input:        ${s.yourInputCount}`,
      `  Adjuster input:     ${s.adjusterInputCount}`,
      `  Yours unmatched:    ${s.unmatchedYoursCount}`,
      `  Adjuster unmatched: ${s.unmatchedAdjusterCount}`,
      `  Avg confidence:     ${s.avgConfidence}`,
      '',
      'PREMATCH PAIRS (grouped by canonical zone)',
    ];
    const byZone = new Map<string, typeof prematchResult.matches>();
    for (const m of prematchResult.matches) {
      const zone = m.yourLine.zone ?? m.adjusterLine.zone ?? 'General';
      if (!byZone.has(zone)) byZone.set(zone, []);
      byZone.get(zone)!.push(m);
    }
    for (const [zone, matches] of byZone) {
      traceLines.push(`\n  [${zone}] — ${matches.length} pairs`);
      for (const m of matches) {
        const yDesc = m.yourLine.description || m.yourLine.rawText;
        const aDesc = m.adjusterLine.description || m.adjusterLine.rawText;
        const yTotal = m.yourLine.costs.total !== null ? `$${m.yourLine.costs.total.toFixed(2)}` : '—';
        const aTotal = m.adjusterLine.costs.total !== null ? `$${m.adjusterLine.costs.total.toFixed(2)}` : '—';
        traceLines.push(
          `    ${m.status} (${Math.round(m.confidence * 100)}%)  y${m.yourLine.lineNumber}: "${yDesc}" ${yTotal}  ↔  a${m.adjusterLine.lineNumber}: "${aDesc}" ${aTotal}`
        );
      }
    }
    traceLines.push('', 'PREMATCH UNMATCHED — YOURS (sent to Sonnet 2)');
    for (const u of prematchResult.unmatchedYourLines) {
      const p = prematchResult.yourParsedMap.get(u.lineNumber);
      const zone = p?.zone ?? '?';
      const desc = p?.description || u.text;
      traceLines.push(`    y${u.lineNumber} [${zone}]: "${desc}"`);
    }
    traceLines.push('', 'PREMATCH UNMATCHED — ADJUSTER (sent to Sonnet 2)');
    for (const u of prematchResult.unmatchedAdjusterLines) {
      const p = prematchResult.adjusterParsedMap.get(u.lineNumber);
      const zone = p?.zone ?? '?';
      const desc = p?.description || u.text;
      traceLines.push(`    a${u.lineNumber} [${zone}]: "${desc}"`);
    }
    traceStep('PREMATCH (DETERMINISTIC)', traceLines.join('\n'));
  }

  const prematchRaw = deterministicMatchesToRawLineItems(prematchResult.matches);
  const prematchRawItems: RawLineItem[] = [];
  for (const item of prematchRaw) {
    const yZone = typeof item.zoneYours === 'string' ? item.zoneYours : null;
    const aZone = typeof item.zoneAdjuster === 'string' ? item.zoneAdjuster : null;
    const resolved = resolveCanonicalZone(yZone, aZone, visionZoneReconciliationResult.zoneMap);
    prematchRawItems.push({ ...item, zoneCanonical: resolved.canonical, zoneConfidence: resolved.confidence });
  }

  const serializedZoneRec: SerializedZoneReconciliation = {
    pairs: visionZoneReconciliationResult.pairs,
    unmatchedYours: visionZoneReconciliationResult.unmatchedYours,
    unmatchedAdjuster: visionZoneReconciliationResult.unmatchedAdjuster,
    zoneMapEntries: [...visionZoneReconciliationResult.zoneMap.entries()],
    skipped: visionZoneReconciliationResult.skipped,
  };

  return {
    useVisionExtraction: true,
    yourEstimateFilename: extracted.yourEstimateFilename,
    adjusterEstimateFilename: extracted.adjusterEstimateFilename,
    linesToChunkYours: prematchResult.unmatchedYourLines,
    linesToChunkAdjuster: prematchResult.unmatchedAdjusterLines,
    yourParsedMapEntries: [...prematchResult.yourParsedMap.entries()],
    adjParsedMapEntries: [...prematchResult.adjusterParsedMap.entries()],
    prematchRawItems,
    visionZoneReconciliation: serializedZoneRec,
  };
}

// ── Stage C: Sonnet pairing (single API call for unmatched lines) ──────────
//
// Wrapper reads the `prematched` payload written by Stage B, runs the impl,
// then carries forward the two fields Stage D needs from prematched (so
// Stage D can read a single state row) and persists the combined `paired`
// payload.

export async function pairStage(comparisonId: string): Promise<PairedState> {
  const prematched = await readStage<PrematchedState>(comparisonId, 'prematched');
  if (!prematched) {
    throw new Error(
      `pairStage: no 'prematched' state found for comparison ${comparisonId} — Stage B must run first.`
    );
  }
  const pairedCore = await pairStageImpl(comparisonId, prematched);
  const paired: PairedState = {
    ...pairedCore,
    prematchRawItems: prematched.prematchRawItems,
    visionZoneReconciliation: prematched.visionZoneReconciliation,
  };
  await writeStage(comparisonId, 'paired', paired);
  return paired;
}

async function pairStageImpl(
  comparisonId: string,
  prematched: PrematchedState,
): Promise<Omit<PairedState, 'prematchRawItems' | 'visionZoneReconciliation'>> {
  const stageStartedAtMs = Date.now();
  const stageTotalTimeoutMs = getProcessingTotalTimeoutMs();
  const chunkTimeoutMs = getProcessingChunkTimeoutMs();
  const assertNotTimedOut = (label: string) => {
    const elapsedMs = Date.now() - stageStartedAtMs;
    if (elapsedMs > stageTotalTimeoutMs) {
      throw new Error(
        `Comparison processing exceeded timeout of ${Math.round(stageTotalTimeoutMs / 1000)}s during ${label}.`
      );
    }
  };

  console.log(
    `[comparison:${comparisonId}] Sending ${prematched.linesToChunkYours.length} yours + ${prematched.linesToChunkAdjuster.length} adjuster lines to Sonnet for pairing.`
  );

  const hasUnmatchedLines = prematched.linesToChunkYours.length > 0 || prematched.linesToChunkAdjuster.length > 0;

  if (!hasUnmatchedLines && prematched.prematchRawItems.length === 0) {
    throw new Error('No extractable text lines were found in one or both PDFs.');
  }

  if (!hasUnmatchedLines) {
    console.log(
      `[comparison:${comparisonId}] Prematch resolved all items — skipping AI processing.`
    );
    return {
      useVisionExtraction: prematched.useVisionExtraction,
      rawLineItems: [],
      allClaudeZoneMappings: [],
    };
  }

  const yourParsedMap = new Map(prematched.yourParsedMapEntries);
  const adjParsedMap = new Map(prematched.adjParsedMapEntries);

  const singleChunk: ComparisonChunk = {
    chunkIndex: 0,
    yourStartLine: prematched.linesToChunkYours[0]?.lineNumber ?? -1,
    yourEndLine: prematched.linesToChunkYours[prematched.linesToChunkYours.length - 1]?.lineNumber ?? -1,
    adjusterStartLine: prematched.linesToChunkAdjuster[0]?.lineNumber ?? -1,
    adjusterEndLine: prematched.linesToChunkAdjuster[prematched.linesToChunkAdjuster.length - 1]?.lineNumber ?? -1,
    yourLines: prematched.linesToChunkYours,
    adjusterLines: prematched.linesToChunkAdjuster,
  };

  const estimatedInputTokens = estimateTokens(
    prematched.linesToChunkYours.map(l => l.text).join('\n') +
    prematched.linesToChunkAdjuster.map(l => l.text).join('\n')
  );
  console.log(
    `[comparison:${comparisonId}] Sending ALL ${prematched.linesToChunkYours.length} yours + ${prematched.linesToChunkAdjuster.length} adjuster lines in single API call (~${estimatedInputTokens} tokens).`
  );

  assertNotTimedOut('single AI call');
  const callStartedAtMs = Date.now();

  const heartbeatHandle: ReturnType<typeof setInterval> = setInterval(() => {
    console.log(
      `[comparison:${comparisonId}] AI call still running (${formatChunkElapsed(callStartedAtMs)} elapsed).`
    );
  }, 30000);

  const abortController = new AbortController();
  let result: ChunkResult;

  try {
    result = await runWithTimeout({
      promise: processChunkWithSubdivision({
        chunk: singleChunk,
        yourFilename: prematched.yourEstimateFilename,
        adjusterFilename: prematched.adjusterEstimateFilename,
        comparisonId,
        chunkLabel: '1/1',
        abortSignal: abortController.signal,
        yourParsedMap,
        adjParsedMap,
        skipZoneMappings: prematched.useVisionExtraction,
      }),
      timeoutMs: chunkTimeoutMs,
      timeoutMessage: `AI call exceeded timeout of ${Math.round(chunkTimeoutMs / 1000)}s.`,
      onTimeout: () => { abortController.abort(); },
    });
  } finally {
    clearInterval(heartbeatHandle);
  }

  const callElapsedSec = ((Date.now() - callStartedAtMs) / 1000).toFixed(1);
  console.log(
    `[comparison:${comparisonId}] AI call done in ${callElapsedSec}s with ${result.lineItems.length} line items, ${result.zoneMappings.length} zone mappings.`
  );

  if (prematched.useVisionExtraction) {
    if (result.zoneMappings.length > 0) {
      console.log(
        `[comparison:${comparisonId}] Vision mode: discarding ${result.zoneMappings.length} inline zone mappings from Sonnet pairing call.`
      );
    }
    return {
      useVisionExtraction: true,
      rawLineItems: result.lineItems,
      allClaudeZoneMappings: [],
    };
  }

  return {
    useVisionExtraction: false,
    rawLineItems: result.lineItems,
    allClaudeZoneMappings: result.zoneMappings,
  };
}

// ── Stage D: Finalize (merge + zone resolution + persist to DB) ────────────
//
// Wrapper reads the `paired` payload (which carries forward the fields
// originally produced by Stage B), runs the impl, and on success deletes
// the comparison_processing_state row — the canonical line items now live
// in the line_items table and the per-stage payloads are no longer needed.
// On failure the row is preserved so a future retry can resume from the
// last completed stage without redoing PDF extraction or Sonnet pairing.

export async function finalizeAndPersistStage(comparisonId: string): Promise<FinalResult> {
  const paired = await readStage<PairedState>(comparisonId, 'paired');
  if (!paired) {
    throw new Error(
      `finalizeAndPersistStage: no 'paired' state found for comparison ${comparisonId} — Stage C must run first.`
    );
  }
  const result = await finalizeAndPersistStageImpl(comparisonId, paired);
  await clearStage(comparisonId);
  return result;
}

async function finalizeAndPersistStageImpl(
  comparisonId: string,
  paired: PairedState,
): Promise<FinalResult> {
  const allRawLineItems: RawLineItem[] = [...paired.prematchRawItems, ...paired.rawLineItems];
  const lineItems = normalizeLineItems(allRawLineItems);

  if (paired.allClaudeZoneMappings.length > 0) {
    // Branch 1: Claude inline zone mappings (legacy mode)
    console.log(
      `[comparison:${comparisonId}] Using ${paired.allClaudeZoneMappings.length} inline zone mappings from Claude (skipping separate reconciliation call).`
    );

    const claudeZoneMap = new Map<string, { canonical: string; confidence: number }>();
    for (const zm of paired.allClaudeZoneMappings) {
      if (zm.yours) claudeZoneMap.set(zm.yours.toLowerCase(), { canonical: zm.canonical, confidence: 100 });
      if (zm.adjuster) claudeZoneMap.set(zm.adjuster.toLowerCase(), { canonical: zm.canonical, confidence: 100 });
    }

    // Pre-dedup is currently DISABLED (see Stage B). Block preserved for parity.
    const zonePreDedupYours = new Map<string, string>();
    const zonePreDedupAdj = new Map<string, string>();
    if (zonePreDedupYours.size > 0 || zonePreDedupAdj.size > 0) {
      const allMerges = new Map<string, string>([...zonePreDedupYours, ...zonePreDedupAdj]);
      for (const [key, entry] of claudeZoneMap) {
        const betterCanonical = allMerges.get(entry.canonical);
        if (betterCanonical) {
          claudeZoneMap.set(key, { canonical: betterCanonical, confidence: entry.confidence });
        }
      }
      for (const [simplified, full] of allMerges) {
        const existing = claudeZoneMap.get(simplified.toLowerCase());
        if (!existing) {
          const fullEntry = claudeZoneMap.get(full.toLowerCase());
          const canonical = fullEntry ? fullEntry.canonical : full;
          claudeZoneMap.set(simplified.toLowerCase(), { canonical, confidence: 95 });
        }
      }
      console.log(
        `[comparison:${comparisonId}] Applied ${allMerges.size} pre-dedup merges to Claude zone map.`
      );
    }

    const canonicalToNames = new Map<string, { yours: string | null; adjuster: string | null }>();
    for (const zm of paired.allClaudeZoneMappings) {
      canonicalToNames.set(zm.canonical.toLowerCase(), { yours: zm.yours, adjuster: zm.adjuster });
    }

    for (const item of lineItems) {
      const yourKey = item.zoneYours?.toLowerCase();
      const adjKey = item.zoneAdjuster?.toLowerCase();
      const yourEntry = yourKey ? claudeZoneMap.get(yourKey) : undefined;
      const adjEntry = adjKey ? claudeZoneMap.get(adjKey) : undefined;
      const canonKey = item.zoneCanonical?.toLowerCase();
      const canonEntry = canonKey ? claudeZoneMap.get(canonKey) : undefined;

      if (yourEntry) {
        item.zoneCanonical = yourEntry.canonical;
        item.zoneConfidence = null;
      } else if (adjEntry) {
        item.zoneCanonical = adjEntry.canonical;
        item.zoneConfidence = null;
      } else if (canonEntry) {
        item.zoneCanonical = canonEntry.canonical;
        item.zoneConfidence = null;
      } else if (!item.zoneCanonical || item.zoneCanonical === 'General') {
        item.zoneCanonical = item.zoneYours ?? item.zoneAdjuster ?? 'General';
        item.zoneConfidence = null;
      }

      const names = item.zoneCanonical
        ? canonicalToNames.get(item.zoneCanonical.toLowerCase())
        : undefined;
      if (names) {
        item.zoneYours = names.yours ?? item.zoneCanonical;
        item.zoneAdjuster = names.adjuster ?? item.zoneCanonical;
      }
    }
  } else if (paired.visionZoneReconciliation) {
    // Branch 2: Vision mode — pre-computed reconciliation from Stage B
    // (carried forward through the `paired` state row).
    console.log(
      `[comparison:${comparisonId}] Using pre-computed vision zone reconciliation (${paired.visionZoneReconciliation.zoneMapEntries.length} zone mappings, skipped=${paired.visionZoneReconciliation.skipped}).`
    );

    const zoneMap = new Map(paired.visionZoneReconciliation.zoneMapEntries);
    for (const item of lineItems) {
      const resolved = resolveCanonicalZone(item.zoneYours, item.zoneAdjuster, zoneMap);
      item.zoneCanonical = resolved.canonical;
      item.zoneConfidence = resolved.confidence > 0 ? resolved.confidence : null;
    }
  } else {
    // Branch 3: Fallback — separate reconciliation call (legacy without inline mappings)
    console.log(
      `[comparison:${comparisonId}] No inline zone mappings from Claude — falling back to separate reconciliation call.`
    );

    const yourZoneSet = new Set<string>();
    const adjusterZoneSet = new Set<string>();
    for (const item of lineItems) {
      if (item.zoneYours) yourZoneSet.add(item.zoneYours);
      if (item.zoneAdjuster) adjusterZoneSet.add(item.zoneAdjuster);
    }

    let zoneReconciliation: ZoneReconciliationResult;
    try {
      zoneReconciliation = await reconcileZones(
        Array.from(yourZoneSet),
        Array.from(adjusterZoneSet),
        comparisonId,
      );
    } catch (zoneError) {
      console.warn(
        `[comparison:${comparisonId}] Zone reconciliation failed, falling back to raw zone names: ${zoneError instanceof Error ? zoneError.message : 'Unknown error'}`
      );
      zoneReconciliation = {
        pairs: [],
        unmatchedYours: Array.from(yourZoneSet),
        unmatchedAdjuster: Array.from(adjusterZoneSet),
        zoneMap: new Map(),
        skipped: true,
      };
    }

    for (const item of lineItems) {
      if (zoneReconciliation.skipped && !zoneReconciliation.zoneMap.size) {
        item.zoneCanonical = item.zoneYours ?? item.zoneAdjuster ?? 'General';
        item.zoneConfidence = null;
      } else {
        const resolved = resolveCanonicalZone(item.zoneYours, item.zoneAdjuster, zoneReconciliation.zoneMap);
        item.zoneCanonical = resolved.canonical;
        item.zoneConfidence = resolved.confidence > 0 ? resolved.confidence : null;
      }
    }
  }

  const aggregates = computeAggregates(lineItems);

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.deleteMany({ where: { comparisonId } });

    if (lineItems.length > 0) {
      await tx.lineItem.createMany({
        data: lineItems.map((item) => ({
          comparisonId,
          matchStatus: item.matchStatus,
          zoneYours: item.zoneYours,
          zoneAdjuster: item.zoneAdjuster,
          zoneCanonical: item.zoneCanonical,
          zoneConfidence: item.zoneConfidence,
          descriptionYours: item.descriptionYours,
          descriptionAdjuster: item.descriptionAdjuster,
          qtyYours: item.qtyYours,
          qtyAdjuster: item.qtyAdjuster,
          removeYours: item.removeYours,
          removeAdjuster: item.removeAdjuster,
          replaceYours: item.replaceYours,
          replaceAdjuster: item.replaceAdjuster,
          resetYours: item.resetYours,
          resetAdjuster: item.resetAdjuster,
          taxYours: item.taxYours,
          taxAdjuster: item.taxAdjuster,
          opYours: item.opYours,
          opAdjuster: item.opAdjuster,
          totalYours: item.totalYours,
          totalAdjuster: item.totalAdjuster,
          diffAmount: item.diffAmount,
          category: item.category,
          sortOrder: item.sortOrder,
          groupId: item.groupId,
        })),
      });
    }

    await tx.comparison.update({
      where: { id: comparisonId },
      data: {
        status: 'COMPLETED',
        errorMessage: null,
        yourEstimateTotal: aggregates.yourEstimateTotal,
        adjusterEstimateTotal: aggregates.adjusterEstimateTotal,
        totalGap: aggregates.totalGap,
        matchCount: aggregates.matchCount,
        modifiedCount: aggregates.modifiedCount,
        missingCount: aggregates.missingCount,
        addedCount: aggregates.addedCount,
      },
    });
  });

  return {
    mode: 'real',
    status: 'COMPLETED',
    lineItemCount: lineItems.length,
  };
}

// ── Orchestrator: thin sequential call of A → B → C → D ───────────────────
// Behavior identical to pre-refactor: same logging, same total-timeout
// enforcement at stage boundaries, same return shape. Each stage internally
// runs as a regular async function call; Phase 6 will swap this orchestrator
// for an Inngest worker that runs the same 4 stages as durable steps.

async function runRealProcessing(comparisonId: string) {
  const startedAtMs = Date.now();
  const totalTimeoutMs = getProcessingTotalTimeoutMs();
  const chunkTimeoutMs = getProcessingChunkTimeoutMs();
  console.log(
    `[comparison:${comparisonId}] Real processing started. Timeout=${Math.round(totalTimeoutMs / 1000)}s, chunkTimeout=${Math.round(chunkTimeoutMs / 1000)}s`
  );
  const assertNotTimedOut = (stage: string) => {
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > totalTimeoutMs) {
      throw new Error(
        `Comparison processing exceeded timeout of ${Math.round(totalTimeoutMs / 1000)}s during ${stage}.`
      );
    }
  };

  assertNotTimedOut('PDF download + extraction');
  await extractStage(comparisonId);

  assertNotTimedOut('zone reconciliation + prematch');
  await reconcileAndPrematchStage(comparisonId);

  assertNotTimedOut('Sonnet pairing');
  await pairStage(comparisonId);

  assertNotTimedOut('finalize + persist');
  const result = await finalizeAndPersistStage(comparisonId);

  console.log(
    `[comparison:${comparisonId}] Real processing completed in ${elapsedSeconds(startedAtMs)}s with ${result.lineItemCount} line items.`
  );

  return result;
}

// ── DEAD CODE: pre-refactor runRealProcessing body — kept temporarily for
// quick rollback during Phase 3 baseline verification, will be deleted after
// the 3 baselines pass diff-check. The block is unreachable (the function
// above returns).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _runRealProcessing_PRE_REFACTOR(comparisonId: string) {
  const startedAtMs = Date.now();
  const totalTimeoutMs = getProcessingTotalTimeoutMs();
  const chunkTimeoutMs = getProcessingChunkTimeoutMs();
  const assertNotTimedOut = (stage: string) => {
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > totalTimeoutMs) {
      throw new Error(
        `Comparison processing exceeded timeout of ${Math.round(totalTimeoutMs / 1000)}s during ${stage}.`
      );
    }
  };

  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      id: true,
      status: true,
      yourEstimateFilename: true,
      adjusterEstimateFilename: true,
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });

  if (!comparison) {
    throw new Error(`Comparison ${comparisonId} not found.`);
  }

  console.log(
    `[comparison:${comparisonId}] Real processing started. Timeout=${Math.round(totalTimeoutMs / 1000)}s, chunkTimeout=${Math.round(chunkTimeoutMs / 1000)}s`
  );

  assertNotTimedOut('PDF download');

  const yourPdfBytes = await downloadPdfBytes(comparison.yourEstimateStoragePath);
  const adjusterPdfBytes = await downloadPdfBytes(comparison.adjusterEstimateStoragePath);

  assertNotTimedOut('PDF extraction');

  const useVisionExtraction = process.env.ENABLE_VISION_EXTRACTION === 'true';
  traceReset();
  let linesToChunkYours: ExtractedLineRecord[];
  let linesToChunkAdjuster: ExtractedLineRecord[];
  let yourParsedMap: Map<number, ParsedScopeFields>;
  let adjParsedMap: Map<number, ParsedScopeFields>;
  const prematchRawItems: RawLineItem[] = [];
  // Zone pre-dedup merge maps (populated during vision extraction, used during zone mapping)
  const zonePreDedupYours = new Map<string, string>();
  const zonePreDedupAdj = new Map<string, string>();
  let visionZoneReconciliation: ZoneReconciliationResult | null = null;

  if (useVisionExtraction) {
    // ── Vision extraction: send raw PDFs to Haiku for structured extraction ──
    console.log(`[comparison:${comparisonId}] Using Haiku vision extraction...`);

    const [yourVision, adjVision] = await Promise.all([
      extractWithVision(yourPdfBytes, { comparisonId, side: 'yours' }),
      extractWithVision(adjusterPdfBytes, { comparisonId, side: 'adjuster' }),
    ]);

    console.log(
      `[comparison:${comparisonId}] Vision extraction complete — yours: ${yourVision.lines.length} items, adjuster: ${adjVision.lines.length} items`
    );

    // ── Step 2: Zone reconciliation (lightweight Claude call) ──────────────
    assertNotTimedOut('zone reconciliation');

    // Collect unique zone names + item counts from Haiku extraction
    const yourZoneCounts = new Map<string, number>();
    for (const p of yourVision.parsedMap.values()) {
      if (p.zone && p.zone.length > 0) {
        yourZoneCounts.set(p.zone, (yourZoneCounts.get(p.zone) ?? 0) + 1);
      }
    }
    const adjZoneCounts = new Map<string, number>();
    for (const p of adjVision.parsedMap.values()) {
      if (p.zone && p.zone.length > 0) {
        adjZoneCounts.set(p.zone, (adjZoneCounts.get(p.zone) ?? 0) + 1);
      }
    }
    const yourZonesWithCounts = [...yourZoneCounts.entries()].map(([name, count]) => ({ name, count }));
    const adjZonesWithCounts = [...adjZoneCounts.entries()].map(([name, count]) => ({ name, count }));

    console.log(
      `[comparison:${comparisonId}] Zones detected (raw) — yours: [${yourZonesWithCounts.map(z => `${z.name}(${z.count})`).join(', ')}], adjuster: [${adjZonesWithCounts.map(z => `${z.name}(${z.count})`).join(', ')}]`
    );

    // ── Step 2a: Deterministic pre-dedup — DISABLED ───────────────────────
    // Pre-dedup was merging distinct zones (e.g. "Retail Space B" → "Retail Space A")
    // because Haiku returns clean zone names — no within-side duplicates to fix.
    // Keeping the code but bypassing it. Cross-side matching is Sonnet 1's job.
    //
    // const { yourDeduped, adjDeduped, yourMergeMap, adjMergeMap } =
    //   preDeduplicateZones(yourZonesWithCounts, adjZonesWithCounts);
    // zonePreDedupYours = yourMergeMap;
    // zonePreDedupAdj = adjMergeMap;
    const yourDeduped = yourZonesWithCounts;
    const adjDeduped = adjZonesWithCounts;

    traceStep('PRE-DEDUP (DISABLED)', [
      'YOURS ZONES (raw from Haiku):',
      ...yourZonesWithCounts.map(z => `  ${z.count}x  ${z.name}`),
      '',
      'ADJUSTER ZONES (raw from Haiku):',
      ...adjZonesWithCounts.map(z => `  ${z.count}x  ${z.name}`),
      '',
      'PRE-DEDUP: disabled — passing raw zones directly to Sonnet 1',
    ].join('\n'));

    try {
      visionZoneReconciliation = await reconcileZones(yourDeduped, adjDeduped, comparisonId);
    } catch (zoneError) {
      console.warn(
        `[comparison:${comparisonId}] Zone reconciliation failed, using raw zone names: ${zoneError instanceof Error ? zoneError.message : 'Unknown'}`
      );
      // Fallback: map each deduped zone to itself
      const fallbackMap = new Map<string, { canonical: string; confidence: number }>();
      const yourDedupedNames = yourDeduped.map(z => z.name);
      const adjDedupedNames = adjDeduped.map(z => z.name);
      for (const z of yourDedupedNames) fallbackMap.set(z.toLowerCase(), { canonical: z, confidence: 0 });
      for (const z of adjDedupedNames) fallbackMap.set(z.toLowerCase(), { canonical: z, confidence: 0 });
      // Pre-dedup disabled — no merge maps to apply
      visionZoneReconciliation = { pairs: [], unmatchedYours: yourDedupedNames, unmatchedAdjuster: adjDedupedNames, zoneMap: fallbackMap, skipped: true };
    }

    // ── Step 3: Map canonical zones onto parsed items ──────────────────────
    const yourParsedWithCanonical: ParsedScopeFields[] = [];
    for (const [, parsed] of yourVision.parsedMap) {
      const rawZone = parsed.zone;
      const entry = rawZone ? visionZoneReconciliation.zoneMap.get(rawZone.toLowerCase()) : null;
      yourParsedWithCanonical.push({
        ...parsed,
        zone: entry ? entry.canonical : (rawZone ?? 'General'),
      });
    }

    const adjParsedWithCanonical: ParsedScopeFields[] = [];
    for (const [, parsed] of adjVision.parsedMap) {
      const rawZone = parsed.zone;
      const entry = rawZone ? visionZoneReconciliation.zoneMap.get(rawZone.toLowerCase()) : null;
      adjParsedWithCanonical.push({
        ...parsed,
        zone: entry ? entry.canonical : (rawZone ?? 'General'),
      });
    }

    // ── Step 4: Run vision prematch within canonical zones ─────────────────
    const prematchResult = runVisionPrematch(yourParsedWithCanonical, adjParsedWithCanonical);

    console.log(
      `[comparison:${comparisonId}] Vision prematch: ${prematchResult.stats.autoMatchedCount} matched ` +
        `(${prematchResult.stats.exactMatchCount} exact, ${prematchResult.stats.modifiedMatchCount} modified), ` +
        `${prematchResult.stats.unmatchedYoursCount} yours unmatched, ${prematchResult.stats.unmatchedAdjusterCount} adjuster unmatched, ` +
        `avg confidence: ${prematchResult.stats.avgConfidence}`
    );

    // ── Trace prematch results ──────────────────────────────────────────────
    {
      const s = prematchResult.stats;
      const traceLines: string[] = [
        'PREMATCH STATS',
        `  Total matched:      ${s.autoMatchedCount}`,
        `    Exact (MATCH):    ${s.exactMatchCount}`,
        `    Modified:         ${s.modifiedMatchCount}`,
        `  Yours input:        ${s.yourInputCount}`,
        `  Adjuster input:     ${s.adjusterInputCount}`,
        `  Yours unmatched:    ${s.unmatchedYoursCount}`,
        `  Adjuster unmatched: ${s.unmatchedAdjusterCount}`,
        `  Avg confidence:     ${s.avgConfidence}`,
        '',
        'PREMATCH PAIRS (grouped by canonical zone)',
      ];

      // Group matches by zone
      const byZone = new Map<string, typeof prematchResult.matches>();
      for (const m of prematchResult.matches) {
        const zone = m.yourLine.zone ?? m.adjusterLine.zone ?? 'General';
        if (!byZone.has(zone)) byZone.set(zone, []);
        byZone.get(zone)!.push(m);
      }
      for (const [zone, matches] of byZone) {
        traceLines.push(`\n  [${zone}] — ${matches.length} pairs`);
        for (const m of matches) {
          const yDesc = m.yourLine.description || m.yourLine.rawText;
          const aDesc = m.adjusterLine.description || m.adjusterLine.rawText;
          const yTotal = m.yourLine.costs.total !== null ? `$${m.yourLine.costs.total.toFixed(2)}` : '—';
          const aTotal = m.adjusterLine.costs.total !== null ? `$${m.adjusterLine.costs.total.toFixed(2)}` : '—';
          traceLines.push(
            `    ${m.status} (${Math.round(m.confidence * 100)}%)  y${m.yourLine.lineNumber}: "${yDesc}" ${yTotal}  ↔  a${m.adjusterLine.lineNumber}: "${aDesc}" ${aTotal}`
          );
        }
      }

      traceLines.push('', 'PREMATCH UNMATCHED — YOURS (sent to Sonnet 2)');
      for (const u of prematchResult.unmatchedYourLines) {
        const p = prematchResult.yourParsedMap.get(u.lineNumber);
        const zone = p?.zone ?? '?';
        const desc = p?.description || u.text;
        traceLines.push(`    y${u.lineNumber} [${zone}]: "${desc}"`);
      }

      traceLines.push('', 'PREMATCH UNMATCHED — ADJUSTER (sent to Sonnet 2)');
      for (const u of prematchResult.unmatchedAdjusterLines) {
        const p = prematchResult.adjusterParsedMap.get(u.lineNumber);
        const zone = p?.zone ?? '?';
        const desc = p?.description || u.text;
        traceLines.push(`    a${u.lineNumber} [${zone}]: "${desc}"`);
      }

      traceStep('PREMATCH (DETERMINISTIC)', traceLines.join('\n'));
    }

    // Convert prematch matches to RawLineItems (with canonical zone + confidence)
    const prematchRaw = deterministicMatchesToRawLineItems(prematchResult.matches);
    for (const item of prematchRaw) {
      // Assign canonical zone from the matched pair's zone
      const yZone = typeof item.zoneYours === 'string' ? item.zoneYours : null;
      const aZone = typeof item.zoneAdjuster === 'string' ? item.zoneAdjuster : null;
      const resolved = resolveCanonicalZone(yZone, aZone, visionZoneReconciliation.zoneMap);
      prematchRawItems.push({
        ...item,
        zoneCanonical: resolved.canonical,
        zoneConfidence: resolved.confidence,
      });
    }

    // Only send UNMATCHED items to Sonnet
    linesToChunkYours = prematchResult.unmatchedYourLines;
    linesToChunkAdjuster = prematchResult.unmatchedAdjusterLines;
    yourParsedMap = prematchResult.yourParsedMap;
    adjParsedMap = prematchResult.adjusterParsedMap;
  } else {
    // ── Legacy extraction: pdf-parse text + regex parsing ────────────────────
    const yourText = await extractPdfText(yourPdfBytes);
    const adjusterText = await extractPdfText(adjusterPdfBytes);

    const yourLineRecordsRaw = toLineRecords(yourText);
    const adjusterLineRecordsRaw = toLineRecords(adjusterText);

    const yourFiltered = filterExtractedLines(yourLineRecordsRaw);
    const adjusterFiltered = filterExtractedLines(adjusterLineRecordsRaw);

    console.log(
      `[comparison:${comparisonId}] Pre-filter (yours): ${yourFiltered.stats.inputCount} → ${yourFiltered.stats.outputCount} lines, ~${yourFiltered.stats.estimatedTokensSaved} tokens saved (chrome:${yourFiltered.stats.droppedPageChrome} meta:${yourFiltered.stats.droppedMetadata} boiler:${yourFiltered.stats.droppedBoilerplate} summary:${yourFiltered.stats.droppedSummaryLines} dup:${yourFiltered.stats.droppedDuplicates})`
    );
    console.log(
      `[comparison:${comparisonId}] Pre-filter (adjuster): ${adjusterFiltered.stats.inputCount} → ${adjusterFiltered.stats.outputCount} lines, ~${adjusterFiltered.stats.estimatedTokensSaved} tokens saved (chrome:${adjusterFiltered.stats.droppedPageChrome} meta:${adjusterFiltered.stats.droppedMetadata} boiler:${adjusterFiltered.stats.droppedBoilerplate} summary:${adjusterFiltered.stats.droppedSummaryLines} dup:${adjusterFiltered.stats.droppedDuplicates})`
    );

    linesToChunkYours = yourFiltered.lines;
    linesToChunkAdjuster = adjusterFiltered.lines;
    yourParsedMap = parseAllLinesWithZones(yourFiltered.lines, yourLineRecordsRaw);
    adjParsedMap = parseAllLinesWithZones(adjusterFiltered.lines, adjusterLineRecordsRaw);
  }

  console.log(
    `[comparison:${comparisonId}] Sending ${linesToChunkYours.length} yours + ${linesToChunkAdjuster.length} adjuster lines to Sonnet for pairing.`
  );

  const hasUnmatchedLines = linesToChunkYours.length > 0 || linesToChunkAdjuster.length > 0;

  if (!hasUnmatchedLines && prematchRawItems.length === 0) {
    throw new Error('No extractable text lines were found in one or both PDFs.');
  }

  const rawLineItems: RawLineItem[] = [];
  const allClaudeZoneMappings: ClaudeZoneMapping[] = [];

  if (!hasUnmatchedLines) {
    console.log(
      `[comparison:${comparisonId}] Prematch resolved all items — skipping AI processing.`
    );
  } else {
    // Send ALL lines to Claude in a single API call (no chunking).
    // The compact text format is small (~20 tokens/line); even 500+ items per
    // side fits well within Claude's 200K context window and Tier 2 rate limits.
    const singleChunk: ComparisonChunk = {
      chunkIndex: 0,
      yourStartLine: linesToChunkYours[0]?.lineNumber ?? -1,
      yourEndLine: linesToChunkYours[linesToChunkYours.length - 1]?.lineNumber ?? -1,
      adjusterStartLine: linesToChunkAdjuster[0]?.lineNumber ?? -1,
      adjusterEndLine: linesToChunkAdjuster[linesToChunkAdjuster.length - 1]?.lineNumber ?? -1,
      yourLines: linesToChunkYours,
      adjusterLines: linesToChunkAdjuster,
    };

    const estimatedInputTokens = estimateTokens(
      linesToChunkYours.map(l => l.text).join('\n') +
      linesToChunkAdjuster.map(l => l.text).join('\n')
    );
    console.log(
      `[comparison:${comparisonId}] Sending ALL ${linesToChunkYours.length} yours + ${linesToChunkAdjuster.length} adjuster lines in single API call (~${estimatedInputTokens} tokens).`
    );

    assertNotTimedOut('single AI call');
    const callStartedAtMs = Date.now();

    const heartbeatHandle: ReturnType<typeof setInterval> = setInterval(() => {
      console.log(
        `[comparison:${comparisonId}] AI call still running (${formatChunkElapsed(callStartedAtMs)} elapsed).`
      );
    }, 30000);

    const abortController = new AbortController();

    let result: ChunkResult;

    try {
      result = await runWithTimeout({
        promise: processChunkWithSubdivision({
          chunk: singleChunk,
          yourFilename: comparison.yourEstimateFilename,
          adjusterFilename: comparison.adjusterEstimateFilename,
          comparisonId,
          chunkLabel: '1/1',
          abortSignal: abortController.signal,
          yourParsedMap,
          adjParsedMap,
          skipZoneMappings: useVisionExtraction,
        }),
        timeoutMs: chunkTimeoutMs,
        timeoutMessage: `AI call exceeded timeout of ${Math.round(chunkTimeoutMs / 1000)}s.`,
        onTimeout: () => {
          abortController.abort();
        },
      });
    } finally {
      clearInterval(heartbeatHandle);
    }

    const elapsedSeconds = ((Date.now() - callStartedAtMs) / 1000).toFixed(1);
    console.log(
      `[comparison:${comparisonId}] AI call done in ${elapsedSeconds}s with ${result.lineItems.length} line items, ${result.zoneMappings.length} zone mappings.`
    );

    rawLineItems.push(...result.lineItems);
    if (useVisionExtraction) {
      // Vision mode: zones already resolved by pre-dedup + Sonnet zone call (#1).
      // Discard any zone mappings Sonnet pairing call (#2) returned — they are
      // redundant and risk overwriting the correct reconciliation.
      if (result.zoneMappings.length > 0) {
        console.log(
          `[comparison:${comparisonId}] Vision mode: discarding ${result.zoneMappings.length} inline zone mappings from Sonnet pairing call.`
        );
      }
    } else {
      allClaudeZoneMappings.push(...result.zoneMappings);
    }
  }

  assertNotTimedOut('line item normalization');

  // Merge deterministic pre-match items (first) with AI-resolved items
  const allRawLineItems: RawLineItem[] = [...prematchRawItems, ...rawLineItems];
  const lineItems = normalizeLineItems(allRawLineItems);

  // ── Zone reconciliation: use Claude's inline zone mappings ──────────────────
  assertNotTimedOut('zone reconciliation');

  if (allClaudeZoneMappings.length > 0) {
    // Claude provided zone mappings inline — build a zone map from them
    console.log(
      `[comparison:${comparisonId}] Using ${allClaudeZoneMappings.length} inline zone mappings from Claude (skipping separate reconciliation call).`
    );

    // Build zone map: raw zone name → { canonical, confidence }
    const claudeZoneMap = new Map<string, { canonical: string; confidence: number }>();
    for (const zm of allClaudeZoneMappings) {
      if (zm.yours) {
        claudeZoneMap.set(zm.yours.toLowerCase(), { canonical: zm.canonical, confidence: 100 });
      }
      if (zm.adjuster) {
        claudeZoneMap.set(zm.adjuster.toLowerCase(), { canonical: zm.canonical, confidence: 100 });
      }
    }

    // Apply zone pre-dedup merge maps to claudeZoneMap:
    // If Sonnet mapped "Common Lobby" → canonical "Common Lobby", but pre-dedup knows
    // "Common Lobby" should be "1st Floor - Common Lobby", fix the canonical.
    if (zonePreDedupYours.size > 0 || zonePreDedupAdj.size > 0) {
      const allMerges = new Map<string, string>([...zonePreDedupYours, ...zonePreDedupAdj]);
      // Fix canonical names that are themselves simplified
      for (const [key, entry] of claudeZoneMap) {
        const betterCanonical = allMerges.get(entry.canonical);
        if (betterCanonical) {
          claudeZoneMap.set(key, { canonical: betterCanonical, confidence: entry.confidence });
        }
      }
      // Also add direct mappings for simplified names → their canonical
      for (const [simplified, full] of allMerges) {
        const existing = claudeZoneMap.get(simplified.toLowerCase());
        if (!existing) {
          // Find what canonical the full name maps to
          const fullEntry = claudeZoneMap.get(full.toLowerCase());
          const canonical = fullEntry ? fullEntry.canonical : full;
          claudeZoneMap.set(simplified.toLowerCase(), { canonical, confidence: 95 });
        }
      }
      console.log(
        `[comparison:${comparisonId}] Applied ${allMerges.size} pre-dedup merges to Claude zone map.`
      );
    }

    // Build reverse lookup: canonical → per-side zone names for display
    const canonicalToNames = new Map<string, { yours: string | null; adjuster: string | null }>();
    for (const zm of allClaudeZoneMappings) {
      canonicalToNames.set(zm.canonical.toLowerCase(), {
        yours: zm.yours,
        adjuster: zm.adjuster,
      });
    }

    // Apply zone mapping to ALL items — even those that already have a
    // zoneCanonical from Claude's pairing step.  This ensures that variant
    // zone names produced by Haiku extraction (e.g. "Plumbing & Additional"
    // vs "Plumbing", "General Items" vs "General") are collapsed to a
    // single canonical name when the zoneMappings say they're the same zone.
    for (const item of lineItems) {
      // 1. Try to resolve via the raw per-side zone names first
      const yourKey = item.zoneYours?.toLowerCase();
      const adjKey = item.zoneAdjuster?.toLowerCase();
      const yourEntry = yourKey ? claudeZoneMap.get(yourKey) : undefined;
      const adjEntry = adjKey ? claudeZoneMap.get(adjKey) : undefined;

      // 2. Also check if the current zoneCanonical itself maps to something
      const canonKey = item.zoneCanonical?.toLowerCase();
      const canonEntry = canonKey ? claudeZoneMap.get(canonKey) : undefined;

      if (yourEntry) {
        item.zoneCanonical = yourEntry.canonical;
        item.zoneConfidence = null;
      } else if (adjEntry) {
        item.zoneCanonical = adjEntry.canonical;
        item.zoneConfidence = null;
      } else if (canonEntry) {
        item.zoneCanonical = canonEntry.canonical;
        item.zoneConfidence = null;
      } else if (!item.zoneCanonical || item.zoneCanonical === 'General') {
        // No mapping found — use raw zone name
        item.zoneCanonical = item.zoneYours ?? item.zoneAdjuster ?? 'General';
        item.zoneConfidence = null;
      }

      // Set per-side zone names from Claude's mappings for UI display
      const names = item.zoneCanonical
        ? canonicalToNames.get(item.zoneCanonical.toLowerCase())
        : undefined;
      if (names) {
        item.zoneYours = names.yours ?? item.zoneCanonical;
        item.zoneAdjuster = names.adjuster ?? item.zoneCanonical;
      }
    }
  } else if (visionZoneReconciliation) {
    // Vision mode: zone reconciliation already completed in Step 2 (pre-dedup + Sonnet zone call)
    console.log(
      `[comparison:${comparisonId}] Using pre-computed vision zone reconciliation (${visionZoneReconciliation.zoneMap.size} zone mappings, skipped=${visionZoneReconciliation.skipped}).`
    );

    for (const item of lineItems) {
      const resolved = resolveCanonicalZone(
        item.zoneYours,
        item.zoneAdjuster,
        visionZoneReconciliation.zoneMap
      );
      item.zoneCanonical = resolved.canonical;
      item.zoneConfidence = resolved.confidence > 0 ? resolved.confidence : null;
    }
  } else {
    // Fallback: no Claude zone mappings and no vision reconciliation
    // Use a separate zone reconciliation call
    console.log(
      `[comparison:${comparisonId}] No inline zone mappings from Claude — falling back to separate reconciliation call.`
    );

    const yourZoneSet = new Set<string>();
    const adjusterZoneSet = new Set<string>();
    for (const item of lineItems) {
      if (item.zoneYours) yourZoneSet.add(item.zoneYours);
      if (item.zoneAdjuster) adjusterZoneSet.add(item.zoneAdjuster);
    }

    let zoneReconciliation: ZoneReconciliationResult;
    try {
      zoneReconciliation = await reconcileZones(
        Array.from(yourZoneSet),
        Array.from(adjusterZoneSet),
        comparisonId
      );
    } catch (zoneError) {
      console.warn(
        `[comparison:${comparisonId}] Zone reconciliation failed, falling back to raw zone names: ${zoneError instanceof Error ? zoneError.message : 'Unknown error'}`
      );
      zoneReconciliation = {
        pairs: [],
        unmatchedYours: Array.from(yourZoneSet),
        unmatchedAdjuster: Array.from(adjusterZoneSet),
        zoneMap: new Map(),
        skipped: true,
      };
    }

    for (const item of lineItems) {
      if (zoneReconciliation.skipped && !zoneReconciliation.zoneMap.size) {
        item.zoneCanonical = item.zoneYours ?? item.zoneAdjuster ?? 'General';
        item.zoneConfidence = null;
      } else {
        const resolved = resolveCanonicalZone(
          item.zoneYours,
          item.zoneAdjuster,
          zoneReconciliation.zoneMap
        );
        item.zoneCanonical = resolved.canonical;
        item.zoneConfidence = resolved.confidence > 0 ? resolved.confidence : null;
      }
    }
  }

  const aggregates = computeAggregates(lineItems);

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.deleteMany({ where: { comparisonId: comparison.id } });

    if (lineItems.length > 0) {
      await tx.lineItem.createMany({
        data: lineItems.map((item) => ({
          comparisonId: comparison.id,
          matchStatus: item.matchStatus,
          zoneYours: item.zoneYours,
          zoneAdjuster: item.zoneAdjuster,
          zoneCanonical: item.zoneCanonical,
          zoneConfidence: item.zoneConfidence,
          descriptionYours: item.descriptionYours,
          descriptionAdjuster: item.descriptionAdjuster,
          qtyYours: item.qtyYours,
          qtyAdjuster: item.qtyAdjuster,
          removeYours: item.removeYours,
          removeAdjuster: item.removeAdjuster,
          replaceYours: item.replaceYours,
          replaceAdjuster: item.replaceAdjuster,
          resetYours: item.resetYours,
          resetAdjuster: item.resetAdjuster,
          taxYours: item.taxYours,
          taxAdjuster: item.taxAdjuster,
          opYours: item.opYours,
          opAdjuster: item.opAdjuster,
          totalYours: item.totalYours,
          totalAdjuster: item.totalAdjuster,
          diffAmount: item.diffAmount,
          category: item.category,
          sortOrder: item.sortOrder,
          groupId: item.groupId,
        })),
      });
    }

    await tx.comparison.update({
      where: { id: comparison.id },
      data: {
        status: 'COMPLETED',
        errorMessage: null,
        yourEstimateTotal: aggregates.yourEstimateTotal,
        adjusterEstimateTotal: aggregates.adjusterEstimateTotal,
        totalGap: aggregates.totalGap,
        matchCount: aggregates.matchCount,
        modifiedCount: aggregates.modifiedCount,
        missingCount: aggregates.missingCount,
        addedCount: aggregates.addedCount,
      },
    });
  });

  console.log(
    `[comparison:${comparisonId}] Real processing completed in ${elapsedSeconds(startedAtMs)}s with ${lineItems.length} line items.`
  );

  return {
    mode: 'real',
    status: 'COMPLETED' as const,
    lineItemCount: lineItems.length,
  };
}

export async function runComparisonProcessing(
  comparisonId: string,
  options: RunComparisonProcessingOptions
) {
  try {
    if (isRealProcessingEnabled()) {
      return await runRealProcessing(comparisonId);
    }

    if (shouldRunComparisonProcessingStub()) {
      const updated = await runComparisonProcessingStub(comparisonId, {
        mode: options.stubMode,
        delayMs: options.stubDelayMs,
      });

      return {
        mode: 'stub',
        status: updated.status,
      };
    }

    return {
      mode: 'disabled',
      status: 'PROCESSING' as const,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 400) : 'Unknown processing error.';

    await prisma.comparison.update({
      where: { id: comparisonId },
      data: {
        status: 'FAILED',
        errorMessage: message,
      },
    });

    throw error;
  }
}
