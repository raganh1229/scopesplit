import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  cleanJsonString,
  parseAndValidate,
  isTruncated,
  withRetry,
  AIResponseError,
} from '@/lib/n2/utils/ai-response';

// ── cleanJsonString ───────────────────────────────────────────────────────────

describe('cleanJsonString', () => {
  it('returns plain JSON object unchanged', () => {
    const input = '{"zones": []}';
    expect(cleanJsonString(input)).toBe('{"zones": []}');
  });

  it('strips ```json...``` fences', () => {
    const input = '```json\n{"zones": []}\n```';
    expect(cleanJsonString(input)).toBe('{"zones": []}');
  });

  it('strips ``` fences without language tag', () => {
    const input = '```\n{"zones": []}\n```';
    expect(cleanJsonString(input)).toBe('{"zones": []}');
  });

  it('strips leading prose before the first {', () => {
    const input = 'Sure, here is the JSON:\n{"matched": []}';
    expect(cleanJsonString(input)).toBe('{"matched": []}');
  });

  it('extracts outermost array when only [ present', () => {
    const input = '[{"zone": "Kitchen"}]';
    expect(cleanJsonString(input)).toBe('[{"zone": "Kitchen"}]');
  });

  it('prefers { over [ when both present', () => {
    const input = '{"key": [1, 2, 3]}';
    expect(cleanJsonString(input)).toBe('{"key": [1, 2, 3]}');
  });

  it('throws AIResponseError when no JSON block found', () => {
    expect(() => cleanJsonString('No JSON here at all')).toThrow(AIResponseError);
    expect(() => cleanJsonString('No JSON here at all')).toThrow('No JSON object found');
  });

  it('handles trailing text after closing }', () => {
    const input = '{"zones": []} extra text here';
    // lastIndexOf('}') finds the closing brace of the JSON object
    expect(cleanJsonString(input)).toBe('{"zones": []}');
  });

  it('handles deeply nested JSON with inner braces', () => {
    const input = '{"a": {"b": {"c": 1}}}';
    expect(cleanJsonString(input)).toBe('{"a": {"b": {"c": 1}}}');
  });
});

// ── parseAndValidate ──────────────────────────────────────────────────────────

describe('parseAndValidate', () => {
  const schema = z.object({ name: z.string(), count: z.number() });

  it('parses and validates valid JSON', () => {
    const result = parseAndValidate('{"name": "Kitchen", "count": 5}', schema, 'test');
    expect(result).toEqual({ name: 'Kitchen', count: 5 });
  });

  it('parses fenced JSON', () => {
    const result = parseAndValidate('```json\n{"name":"Bath","count":3}\n```', schema, 'test');
    expect(result).toEqual({ name: 'Bath', count: 3 });
  });

  it('throws AIResponseError on invalid JSON syntax', () => {
    expect(() => parseAndValidate('{bad json}', schema, 'ctx')).toThrow(AIResponseError);
  });

  it('throws AIResponseError on schema mismatch', () => {
    expect(() =>
      parseAndValidate('{"name": "Kitchen", "count": "five"}', schema, 'ctx'),
    ).toThrow(AIResponseError);
  });

  it('error message includes context label', () => {
    try {
      parseAndValidate('{invalid}', schema, 'pass3-chunk-2');
    } catch (e) {
      expect((e as AIResponseError).context).toBe('pass3-chunk-2');
    }
  });
});

// ── isTruncated ───────────────────────────────────────────────────────────────

describe('isTruncated', () => {
  it('returns true when stop_reason is max_tokens', () => {
    expect(isTruncated('max_tokens')).toBe(true);
  });

  it('returns false when stop_reason is end_turn', () => {
    expect(isTruncated('end_turn')).toBe(false);
  });

  it('returns false when stop_reason is stop_sequence', () => {
    expect(isTruncated('stop_sequence')).toBe(false);
  });

  it('uses heuristic when stop_reason is null and output ends with }', () => {
    expect(isTruncated(null, '{"zones": []}')).toBe(false);
  });

  it('uses heuristic when stop_reason is null and output ends with ]', () => {
    expect(isTruncated(null, '[{"zone": "Kitchen"}]')).toBe(false);
  });

  it('returns true via heuristic when output is cut off mid-JSON', () => {
    expect(isTruncated(null, '{"zones": [{"name": "Kitchen"')).toBe(true);
  });

  it('returns false when no rawOutput and stop_reason is null', () => {
    expect(isTruncated(null)).toBe(false);
  });

  it('returns false when stop_reason is undefined and output ends properly', () => {
    expect(isTruncated(undefined, '{"zones": []}')).toBe(false);
  });
});

// ── withRetry ─────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 3, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable AIResponseError and eventually succeeds', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new AIResponseError('bad json', true, 'test');
      return 'success';
    });
    const result = await withRetry(fn, 3, 'test');
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on non-retryable AIResponseError', async () => {
    const fn = vi.fn().mockRejectedValue(new AIResponseError('auth error', false, 'test'));
    await expect(withRetry(fn, 3, 'test')).rejects.toThrow('auth error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts all attempts and throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new AIResponseError('always fails', true, 'test'));
    await expect(withRetry(fn, 3, 'test')).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on generic Error (not AIResponseError)', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new Error('transient network error');
      return 'recovered';
    });
    const result = await withRetry(fn, 3, 'test');
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
