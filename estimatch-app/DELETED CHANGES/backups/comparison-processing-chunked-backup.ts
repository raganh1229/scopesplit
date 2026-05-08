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
  isPrematchEnabled,
  runDeterministicPrematch,
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

const ESTIMATES_BUCKET = 'estimates';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MAX_INPUT_TOKENS_PER_REQUEST = 160000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_TOKENS_OUTPUT = 16000;
const DEFAULT_MIN_MS_BETWEEN_ANTHROPIC_REQUESTS = 8000;
const DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_PROCESSING_CHUNK_TIMEOUT_MS = 300000;
const DEFAULT_PROCESSING_TOTAL_TIMEOUT_MS = 1200000;

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

function isRealProcessingEnabled(): boolean {
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
  if (Number.isFinite(parsed) && parsed >= 500 && parsed <= 16000) return Math.floor(parsed);
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
  const qtyUnit = parsed.quantity
    ? `|${parsed.quantity}${parsed.unit ? ' ' + parsed.unit : ''}`
    : '';
  const totalCost = parsed.costs.total !== null
    ? `|$${parsed.costs.total.toFixed(2)}`
    : '';
  return `${record.lineNumber}|${desc}${qtyUnit}${totalCost}`;
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
    qtyYours: yours?.quantity ?? null,
    qtyAdjuster: adj?.quantity ?? null,
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
    'You will receive line items from two Xactimate estimates (Contractor and Adjuster) for the same property damage claim.',
    'Items have NO pre-assigned zones. Lines are in DOCUMENT ORDER — the order they appear in the original PDF.',
    'Lines marked [ZONE?] are potential zone/room headers that appear between scope items.',
    'Your job is to:',
    '  1. IDENTIFY which [ZONE?] markers are real zone headers (rooms/areas) vs misidentified line items',
    '  2. ASSIGN every scope item to a zone based on which [ZONE?] header it falls under in document order',
    '  3. RECONCILE zone names across the two estimates (same room, different name)',
    '  4. PAIR matching line items between the two estimates',
    '',
    '═══════════════════════════════════════════════════════════════',
    'DOMAIN CONTEXT',
    '═══════════════════════════════════════════════════════════════',
    '- Xactimate estimates contain scope-of-work line items grouped by zone/room (e.g., "Kitchen", "Master Bedroom", "Hall Bath", "Exterior / Windows").',
    '- Two independent estimators (contractor and adjuster) write separate estimates for the same property damage.',
    '- The same work item often appears with different wording, abbreviations, units, or prices.',
    '- Different zones frequently contain structurally similar items (e.g., every room may have "ceiling drywall", "wall paint", "carpet").',
    '- Zone names between estimates may use different labels for the same room (e.g., "Living Area" vs "Living Room", "Bath" vs "Bathroom", "Exterior" vs "Exterior / Windows").',
    '',
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
    '',
    '═══════════════════════════════════════════════════════════════',
    'ITEM MATCHING RULES (in priority order)',
    '═══════════════════════════════════════════════════════════════',
    '1. ZONE AWARENESS: Prefer matching items within the same or equivalent zone. Items with similar descriptions in different zones MAY be different work in different rooms.',
    '2. DESCRIPTION SIMILARITY: Match items describing the same trade/work even with different wording (e.g., "R&R Base cabinets" ↔ "Remove & replace lower cabinets", "Tear out ceiling drywall" ↔ "Demo ceiling drywall").',
    '3. TOTAL COST AS CONFIRMING SIGNAL: If two items have similar descriptions AND similar total costs, they are very likely the same item. If descriptions are similar but costs are significantly different, they are likely still the same item with a pricing dispute — still match them.',
    '4. ONE-TO-ONE: Each line number must appear in exactly one pair. Never duplicate a line number across pairs.',
    '5. UNMATCHED ITEMS: If a line has no reasonable counterpart, emit it as unmatched (y:null or a:null). Do not force bad matches.',
    '6. CROSS-ZONE MATCHING: Only match items across different zones if there is no reasonable in-zone candidate AND the descriptions are highly similar. This is acceptable but should be the exception.',
    '7. ZONE OVERRIDE: If a suggested zone assignment looks wrong (e.g., a window item assigned to "Hall Bath" when "Exterior / Windows" exists), assign the item to the correct zone in your output.',
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
    '1. You must ONLY use zone names that ALREADY EXIST in the input text — from [ZONE?] markers or from the "All detected zones" context list. Do NOT invent, fabricate, or infer zone names that do not appear in the provided data.',
    '2. Every line number in your output MUST exist in the input. NEVER invent or fabricate line numbers.',
    '3. Every canonical zone name in zoneMappings MUST come from an actual zone name present in the input. Do not create new names by combining or paraphrasing zone names.',
    '4. If you are unsure about a zone assignment, assign to "General" rather than guessing.',
    '5. Do NOT add commentary, explanations, markdown formatting, or notes. Return ONLY the raw JSON object specified below.',
    '6. Do NOT wrap the JSON in ```json``` code fences or any other formatting.',
    '',
    '═══════════════════════════════════════════════════════════════',
    'INPUT FORMAT',
    '═══════════════════════════════════════════════════════════════',
    'Scope line items: lineNumber|description|quantity unit|$totalCost',
    'Zone candidates: [ZONE?] ZoneName',
    '',
    '═══════════════════════════════════════════════════════════════',
    'OUTPUT FORMAT',
    '═══════════════════════════════════════════════════════════════',
    'Return ONLY this JSON structure — nothing else:',
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
    '- Every input line number must appear exactly once across all pairs.',
    '- [ZONE?] markers should NOT appear in pairs — they are zone headers, not line items (unless you determined they are actually line items, in which case treat them as scope items).',
  ].join('\n');

  // Build zone context for Claude — zone candidates detected in this chunk
  const zoneContext = [
    `Zone candidates detected (contractor): ${yourZoneCandidates.join(', ') || '[none]'}`,
    `Zone candidates detected (adjuster): ${adjZoneCandidates.join(', ') || '[none]'}`,
  ].join('\n');

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
            text:
              `Analyze these two Xactimate estimate sections. Items are in DOCUMENT ORDER with NO pre-assigned zones. Identify zone headers from [ZONE?] markers, assign every item to a zone, reconcile zones across estimates, and pair matching items.\n\nEach scope line is formatted as: lineNumber|description|quantity unit|$totalCost\nZone candidate markers appear as: [ZONE?] ZoneName — items below a [ZONE?] marker belong to that zone until the next marker.\n\n${zoneContext}\n\nRemember:\n- Identify [ZONE?] markers: real zone headers name rooms/areas (Kitchen, Bedroom, Exterior), NOT building components (Fascia, Soffit, Drywall).\n- Assign zones: each scope item belongs to the nearest [ZONE?] header ABOVE it in document order.\n- Reconcile zones: map contractor zones to adjuster zones where they refer to the same physical space.\n- Pair items: prefer same-zone matches, use description + total cost as signals.\n- Every input line number must appear exactly once in the output pairs.\n- NEVER invent line numbers or zone names that do not exist in the input.\n- Return RAW JSON only, no markdown fences, no commentary.`,
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
    return { lineItems: resolvedItems, zoneMappings };
  }

  // Fall back to legacy format (Claude returned lineItems instead of pairs)
  console.warn(
    `[comparison:${params.comparisonId}] Chunk ${params.chunkLabel}/d${params.depth} returned legacy format — using lineItems directly.`
  );
  const legacy = ensurePayloadShape(parsed);
  return { ...legacy, zoneMappings };
}

async function runRealProcessing(comparisonId: string) {
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

  assertNotTimedOut('PDF text extraction');

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

  // ── Deterministic pre-match: resolve obvious matches without AI ──────────
  let prematchRawItems: RawLineItem[] = [];
  let linesToChunkYours = yourFiltered.lines;
  let linesToChunkAdjuster = adjusterFiltered.lines;
  let yourParsedMap: Map<number, ParsedScopeFields>;
  let adjParsedMap: Map<number, ParsedScopeFields>;

  if (isPrematchEnabled()) {
    const prematch = runDeterministicPrematch(yourFiltered.lines, adjusterFiltered.lines);
    console.log(
      `[comparison:${comparisonId}] Prematch: ${prematch.stats.autoMatchedCount} auto-paired (${prematch.stats.exactMatchCount} MATCH, ${prematch.stats.modifiedMatchCount} MODIFIED, avg confidence ${prematch.stats.avgConfidence}), ${prematch.stats.unmatchedYoursCount} yours + ${prematch.stats.unmatchedAdjusterCount} adjuster remaining for AI.`
    );
    prematchRawItems = deterministicMatchesToRawLineItems(prematch.matches) as RawLineItem[];
    yourParsedMap = prematch.yourParsedMap;
    adjParsedMap = prematch.adjusterParsedMap;
    // Send ALL unmatched lines to Claude — including zone candidates.
    // formatLineForClaude marks non-scope lines as [ZONE?] or skips junk.
    // Claude validates which candidates are real zone headers.
    linesToChunkYours = prematch.unmatchedYourLines;
    linesToChunkAdjuster = prematch.unmatchedAdjusterLines;
    const scopeYours = linesToChunkYours.filter(l => yourParsedMap.has(l.lineNumber)).length;
    const scopeAdj = linesToChunkAdjuster.filter(l => adjParsedMap.has(l.lineNumber)).length;
    const candidateYours = linesToChunkYours.length - scopeYours;
    const candidateAdj = linesToChunkAdjuster.length - scopeAdj;
    console.log(
      `[comparison:${comparisonId}] Sending to Claude: ${scopeYours} scope + ${candidateYours} zone candidate lines (yours), ${scopeAdj} scope + ${candidateAdj} zone candidate lines (adjuster).`
    );
  } else {
    yourParsedMap = parseAllLinesWithZones(yourFiltered.lines);
    adjParsedMap = parseAllLinesWithZones(adjusterFiltered.lines);
  }

  const chunks = buildChunks(linesToChunkYours, linesToChunkAdjuster);

  if (chunks.length === 0 && prematchRawItems.length === 0) {
    throw new Error('No extractable text lines were found in one or both PDFs.');
  }

  if (chunks.length === 0) {
    console.log(
      `[comparison:${comparisonId}] Prematch resolved all items — skipping AI processing.`
    );
  } else {
    console.log(
      `[comparison:${comparisonId}] Built ${chunks.length} chunks for AI (compact prompt: description + qty/unit only).`
    );
  }

  const rawLineItems: RawLineItem[] = [];
  const allClaudeZoneMappings: ClaudeZoneMapping[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) continue;

    assertNotTimedOut(`chunk ${index + 1}/${chunks.length}`);
    const chunkStartedAtMs = Date.now();
    const chunkLabel = `${index + 1}/${chunks.length}`;
    console.log(
      `[comparison:${comparisonId}] Chunk ${chunkLabel} start (y:${chunk.yourStartLine}-${chunk.yourEndLine}, a:${chunk.adjusterStartLine}-${chunk.adjusterEndLine}).`
    );

    const heartbeatHandle: ReturnType<typeof setInterval> = setInterval(() => {
      console.log(
        `[comparison:${comparisonId}] Chunk ${chunkLabel} still running (${formatChunkElapsed(chunkStartedAtMs)} elapsed).`
      );
    }, 30000);

    const chunkAbortController = new AbortController();

    let chunkResult: ChunkResult;

    try {
      chunkResult = await runWithTimeout({
        promise: processChunkWithSubdivision({
          chunk,
          yourFilename: comparison.yourEstimateFilename,
          adjusterFilename: comparison.adjusterEstimateFilename,
          comparisonId,
          chunkLabel,
          abortSignal: chunkAbortController.signal,
          yourParsedMap,
          adjParsedMap,
        }),
        timeoutMs: chunkTimeoutMs,
        timeoutMessage: `Chunk ${chunkLabel} exceeded timeout of ${Math.round(chunkTimeoutMs / 1000)}s.`,
        onTimeout: () => {
          chunkAbortController.abort();
        },
      });
    } finally {
      clearInterval(heartbeatHandle);
    }

    const chunkElapsedSeconds = ((Date.now() - chunkStartedAtMs) / 1000).toFixed(1);
    console.log(
      `[comparison:${comparisonId}] Chunk ${chunkLabel} done in ${chunkElapsedSeconds}s with ${chunkResult.lineItems.length} line items, ${chunkResult.zoneMappings.length} zone mappings.`
    );

    rawLineItems.push(...chunkResult.lineItems);
    allClaudeZoneMappings.push(...chunkResult.zoneMappings);
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

    // Apply to all items — Claude-paired items already have zoneCanonical set,
    // but prematch items need their zones resolved via the mapping
    for (const item of lineItems) {
      // If item already has a Claude-assigned zoneCanonical (from pair.zone), keep it
      if (item.zoneCanonical && item.zoneCanonical !== 'General') {
        item.zoneConfidence = null;
        continue;
      }

      // For prematch items: look up raw zone names in Claude's mapping
      const yourKey = item.zoneYours?.toLowerCase();
      const adjKey = item.zoneAdjuster?.toLowerCase();
      const yourEntry = yourKey ? claudeZoneMap.get(yourKey) : undefined;
      const adjEntry = adjKey ? claudeZoneMap.get(adjKey) : undefined;

      if (yourEntry) {
        item.zoneCanonical = yourEntry.canonical;
        item.zoneConfidence = null;
      } else if (adjEntry) {
        item.zoneCanonical = adjEntry.canonical;
        item.zoneConfidence = null;
      } else {
        // No mapping found — use raw zone name
        item.zoneCanonical = item.zoneYours ?? item.zoneAdjuster ?? 'General';
        item.zoneConfidence = null;
      }
    }
  } else {
    // Fallback: no Claude zone mappings (e.g., prematch resolved everything, or old-format response)
    // Use the separate zone reconciliation call
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
