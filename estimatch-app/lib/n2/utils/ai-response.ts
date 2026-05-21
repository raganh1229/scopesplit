// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — AI response pipeline: clean → parse → validate
//
// Shared by every pass (1/2, 3, 4A, 4B, LZF tiers). The pipeline is:
//   1. cleanJsonString()  — strips markdown fences, extracts outermost JSON
//   2. JSON.parse()       — throws retryable AIResponseError on failure
//   3. schema.safeParse() — throws retryable AIResponseError on schema mismatch
//
// On any failure, the caller's retry loop (3× per chunk/zone) handles the
// retry. AIResponseError carries a `retryable` flag for future distinctions
// (e.g. a non-retryable auth error vs a transient JSON truncation).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// ── Error Type ────────────────────────────────────────────────────────────────

export class AIResponseError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly context?: string,
  ) {
    super(message);
    this.name = 'AIResponseError';
  }
}

// ── Step 1: Clean ─────────────────────────────────────────────────────────────

/**
 * Strips surrounding whitespace, markdown code fences (```json...``` or
 * ```...```), and any leading/trailing non-JSON text. Returns the outermost
 * {...} or [...] block as a raw string ready for JSON.parse().
 *
 * Throws AIResponseError (retryable: true) if no JSON block is found.
 */
export function cleanJsonString(raw: string): string {
  let s = raw.trim();

  // Strip markdown fences: optional "json" language tag
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Find outermost { or [
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');

  if (firstBrace === -1 && firstBracket === -1) {
    throw new AIResponseError('No JSON object found in AI response', true);
  }

  // Prefer { over [ always (all our prompts return objects).
  // Only use [ as a fallback when no { exists AND the character immediately
  // following [ (ignoring whitespace) is a valid JSON array element opener:
  // {  "  digit  [  ]  (i.e. NOT a letter like "[ SETTLEMENT...").
  const bracketIsValidJson =
    firstBracket !== -1 &&
    /^\s*[{\["'\d\[\]]/.test(s.slice(firstBracket + 1));
  const useObject =
    firstBrace !== -1 && (firstBracket === -1 || !bracketIsValidJson || firstBrace < firstBracket);

  if (!useObject && !bracketIsValidJson) {
    throw new AIResponseError('No JSON object found in AI response', true);
  }

  const startChar = useObject ? '{' : '[';
  const endChar = useObject ? '}' : ']';

  const start = s.indexOf(startChar);
  const end = s.lastIndexOf(endChar);

  if (start === -1 || end === -1 || end <= start) {
    throw new AIResponseError('Could not extract balanced JSON from AI response', true);
  }

  return s.slice(start, end + 1);
}

// ── Step 2 + 3: Parse + Validate ─────────────────────────────────────────────

/**
 * Cleans, parses, and validates an AI response string against a Zod schema.
 *
 * @param raw      Raw string returned by the Anthropic SDK
 * @param schema   Zod schema to validate the parsed value against
 * @param context  Short label for error messages (e.g. "pass1-chunk-3")
 * @returns        The parsed and validated value typed as T
 * @throws         AIResponseError (retryable: true) on any failure
 */
export function parseAndValidate<T>(
  raw: string,
  schema: z.ZodSchema<T>,
  context: string,
): T {
  const cleaned = cleanJsonString(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Recoverable case: JSON.parse succeeded on a leading object/array but
    // hit unexpected content afterward. Both V8 ("Unexpected non-whitespace
    // character after JSON at position N") and other engines surface the
    // exact position of the trailing junk. If we can find it, slice off
    // the trailing content and retry — this rescues Opus responses that
    // append explanation text or a stray markdown fence after their JSON.
    const errMsg = (e as Error).message;
    const positionMatch = errMsg.match(/after JSON at position (\d+)/i);
    if (positionMatch) {
      const cutAt = Number(positionMatch[1]);
      if (Number.isFinite(cutAt) && cutAt > 0 && cutAt <= cleaned.length) {
        try {
          parsed = JSON.parse(cleaned.slice(0, cutAt));
        } catch {
          // Fall through to the original failure path below.
        }
      }
    }

    if (parsed === undefined) {
      throw new AIResponseError(
        `JSON.parse failed in ${context}: ${errMsg.slice(0, 200)}`,
        true,
        context,
      );
    }
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    // Truncate the Zod error message to avoid enormous log lines
    const msg = result.error.message.slice(0, 400);
    throw new AIResponseError(
      `Schema validation failed in ${context}: ${msg}`,
      true,
      context,
    );
  }

  return result.data;
}

// ── Truncation Detection ──────────────────────────────────────────────────────

/**
 * Returns true if the Anthropic SDK indicates the response was cut off by the
 * output token limit. Authoritative check: `stop_reason === 'max_tokens'`.
 *
 * Falls back to a heuristic (response doesn't end with } or ]) when
 * stop_reason is unavailable (e.g. when using a thin wrapper).
 */
export function isTruncated(
  stopReason: string | null | undefined,
  rawOutput?: string,
): boolean {
  if (stopReason === 'max_tokens') return true;
  if (stopReason != null) return false; // explicit non-truncation stop reason
  // Heuristic fallback when stop_reason unavailable
  if (rawOutput != null) {
    const trimmed = rawOutput.trimEnd();
    return !trimmed.endsWith('}') && !trimmed.endsWith(']');
  }
  return false;
}

// ── Retry Helper ──────────────────────────────────────────────────────────────

/**
 * Executes `fn` up to `maxAttempts` times, retrying on AIResponseError
 * (retryable: true) or any transient Error. Non-retryable AIResponseErrors
 * re-throw immediately.
 *
 * Backoff strategy:
 *  - 429 rate-limit errors: base 10 000 ms (10s → 20s → 40s…)
 *  - All other retryable errors: base 500 ms (500ms → 1s → 2s…)
 * Jitter of 0–1 000 ms is added in both cases.
 *
 * @param fn          Async function to retry
 * @param maxAttempts Total attempts (not retries), default 5
 * @param context     Label for structured log output
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 5,
  context = 'unknown',
): Promise<T> {
  let lastError: Error = new Error('No attempts made');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (err instanceof AIResponseError && !err.retryable) {
        throw err; // non-retryable — surface immediately
      }

      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt) break;

      const is429 =
        lastError.message.includes('429') ||
        lastError.message.toLowerCase().includes('too many requests');
      const baseDelay = is429 ? 10_000 : 500;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1_000;
      console.warn(
        `[n2] ${context} attempt ${attempt + 1}/${maxAttempts} failed — retrying in ${Math.round(delay)}ms`,
        { error: lastError.message },
      );
      await new Promise(res => setTimeout(res, delay));
    }
  }

  throw lastError;
}
