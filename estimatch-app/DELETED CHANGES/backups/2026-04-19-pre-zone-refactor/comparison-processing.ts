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
} from '@/lib/deterministic-prematch';
import type { ParsedScopeFields } from '@/lib/deterministic-prematch';
import { reconcileZones, resolveCanonicalZone } from '@/lib/zone-reconciliation';
import type { ZoneReconciliationResult } from '@/lib/zone-reconciliation';

const ESTIMATES_BUCKET = 'estimates';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MAX_INPUT_TOKENS_PER_REQUEST = 18000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_TOKENS_OUTPUT = 4000;
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
    zoneCanonical: null,
    zoneConfidence: null,
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
}): Promise<RawLineItem[]> {
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

    return payload.lineItems;
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

    for (const childChunk of children) {
      const childLineItems = await processChunkWithSubdivision({
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
      recoveredLineItems.push(...childLineItems);
    }

    return recoveredLineItems;
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
};

function formatCompactLine(
  record: ExtractedLineRecord,
  parsedMap: Map<number, ParsedScopeFields>
): string {
  let parsed = parsedMap.get(record.lineNumber);
  if (!parsed) {
    parsed = parseLineToFields(record);
  }
  const zone = parsed.zone ?? 'unknown';
  const desc = parsed.description || record.text;
  const qtyUnit = parsed.quantity
    ? `|${parsed.quantity}${parsed.unit ? ' ' + parsed.unit : ''}`
    : '';
  return `${record.lineNumber}|${zone}|${desc}${qtyUnit}`;
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
    }))
    .filter((p) => p.y !== null || p.a !== null);
}

function buildRawLineItemFromParsed(
  matchStatus: string,
  yours: ParsedScopeFields | null,
  adj: ParsedScopeFields | null,
  sortOrder: number
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
        const qtyEqual = yours.quantity === adj.quantity;
        matchStatus = allCostsEqual && qtyEqual ? 'MATCH' : 'MODIFIED';
      } else {
        matchStatus = 'MODIFIED'; // can't verify costs — safe default
      }
    } else if (pair.y !== null) {
      matchStatus = 'MISSING_FROM_ADJUSTER';
    } else {
      matchStatus = 'ADDED_BY_ADJUSTER';
    }

    items.push(buildRawLineItemFromParsed(matchStatus, yours, adj, i));
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
  const yourCompactText = params.chunk.yourLines
    .map((r) => formatCompactLine(r, params.yourParsedMap))
    .join('\n');
  const adjusterCompactText = params.chunk.adjusterLines
    .map((r) => formatCompactLine(r, params.adjParsedMap))
    .join('\n');

  const yourHash = sha256(yourCompactText);
  const adjusterHash = sha256(adjusterCompactText);

  const systemPrompt = [
    'You are an expert insurance estimate analyst specializing in Xactimate line-item matching.',
    '',
    'DOMAIN CONTEXT:',
    '- Xactimate estimates contain scope-of-work line items grouped by zone/room (e.g., "Kitchen", "Master Bedroom", "Hall Bath").',
    '- Two independent estimators (contractor and adjuster) write separate estimates for the same property damage.',
    '- The same work item often appears with different wording, abbreviations, units, or prices.',
    '- Different zones frequently contain structurally similar items (e.g., every room may have "ceiling drywall", "wall paint", "carpet").',
    '- Zone names between estimates may use different labels for the same room (e.g., "Living Area" vs "Living Room", "Bath" vs "Bathroom").',
    '',
    'MATCHING RULES (in priority order):',
    '1. ZONE FIRST: Always prefer matching items within the same or equivalent zone. Two items with similar descriptions but in different zones are almost certainly different work — do NOT cross-zone match them unless no reasonable in-zone candidate exists.',
    '2. DESCRIPTION SIMILARITY: Match items describing the same trade/work even with different wording (e.g., "R&R Base cabinets" ↔ "Remove & replace lower cabinets", "Tear out ceiling drywall" ↔ "Demo ceiling drywall").',
    '3. ONE-TO-ONE: Each line number must appear in exactly one pair. Never duplicate a line number across pairs.',
    '4. UNMATCHED ITEMS: If a line has no reasonable counterpart, emit it as unmatched (y:null or a:null). Do not force bad matches.',
    '',
    'COMMON PATTERNS:',
    '- Abbreviations: R&R = Remove & Replace, SF = Square Feet, LF = Linear Feet, EA = Each, SY = Square Yard',
    '- "Detach & reset" ≈ "R&R" for fixtures',
    '- Description differences are normal (e.g., "Dumpster load - 20 yards" ↔ "Dumpster - debris removal")',
    '- Grade/finish differences are normal (e.g., "standard grade" ↔ "economy grade", "satin" ↔ "eggshell")',
    '',
    'OUTPUT FORMAT:',
    'Return ONLY valid JSON, no commentary:',
    '{"pairs":[{"y":number|null,"a":number|null}]}',
    '- y = contractor line number, a = adjuster line number',
    '- Matched pair: both y and a are numbers',
    '- Contractor-only: {"y":number,"a":null}',
    '- Adjuster-only: {"y":null,"a":number}',
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
              `Match line items between these two Xactimate estimate sections. Each line is formatted as: lineNumber|zone|description|quantity unit\n\nRemember: prioritize zone-aware matching. Items in the same zone with similar descriptions are strong pair candidates. Items in different zones with similar descriptions are usually different work items in different rooms — avoid cross-zone pairing unless no in-zone match exists.\n\nEvery input line number must appear exactly once in the output. Never invent line numbers.`,
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
  if (compactPairs.length > 0) {
    const resolvedItems = resolveCompactPairsToRawItems(
      compactPairs,
      params.yourParsedMap,
      params.adjParsedMap,
      params.chunk.yourLines,
      params.chunk.adjusterLines
    );
    return { lineItems: resolvedItems };
  }

  // Fall back to legacy format (Claude returned lineItems instead of pairs)
  console.warn(
    `[comparison:${params.comparisonId}] Chunk ${params.chunkLabel}/d${params.depth} returned legacy format — using lineItems directly.`
  );
  return ensurePayloadShape(parsed);
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
    // Only send validated scope lines to Claude — filter out zone headers,
    // dimension lines, and non-scope content that produce garbage descriptions
    linesToChunkYours = prematch.unmatchedYourLines.filter(
      (l) => yourParsedMap.has(l.lineNumber)
    );
    linesToChunkAdjuster = prematch.unmatchedAdjusterLines.filter(
      (l) => adjParsedMap.has(l.lineNumber)
    );
    const droppedYours = prematch.unmatchedYourLines.length - linesToChunkYours.length;
    const droppedAdj = prematch.unmatchedAdjusterLines.length - linesToChunkAdjuster.length;
    if (droppedYours > 0 || droppedAdj > 0) {
      console.log(
        `[comparison:${comparisonId}] Scope filter: dropped ${droppedYours} yours + ${droppedAdj} adjuster non-scope lines (zone headers, dimensions, etc.) from AI payload.`
      );
    }
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

    let chunkLineItems: RawLineItem[];

    try {
      chunkLineItems = await runWithTimeout({
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
      `[comparison:${comparisonId}] Chunk ${chunkLabel} done in ${chunkElapsedSeconds}s with ${chunkLineItems.length} line items.`
    );

    rawLineItems.push(...chunkLineItems);
  }

  assertNotTimedOut('line item normalization');

  // Merge deterministic pre-match items (first) with AI-resolved items
  const allRawLineItems: RawLineItem[] = [...prematchRawItems, ...rawLineItems];
  const lineItems = normalizeLineItems(allRawLineItems);

  // ── Zone reconciliation: AI-match zone names across the two estimates ──────
  assertNotTimedOut('zone reconciliation');

  // Collect unique zone names from all resolved line items
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
    // Zone reconciliation failure is non-fatal — fall back to raw zone names
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

  // Apply canonical zone names to every line item
  for (const item of lineItems) {
    if (zoneReconciliation.skipped && !zoneReconciliation.zoneMap.size) {
      // No reconciliation data — use raw zone (prefer yours, fall back to adjuster)
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
