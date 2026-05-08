import {
  runDeterministicPrematch,
  deterministicMatchesToRawLineItems,
  parseLineToFields,
  type PrematchLineRecord,
} from './deterministic-prematch';

function line(num: number, text: string): PrematchLineRecord {
  return { lineNumber: num, text };
}

describe('parseLineToFields', () => {
  it('extracts quantity, unit, costs from typical Xactimate line', () => {
    const parsed = parseLineToFields(
      line(1, 'RFG Remove Comp. shingles - 3 tab/25yr 14.50 SQ 24.56 356.12')
    );
    expect(parsed.unit).toBe('SQ');
    expect(parsed.quantity).toBe('14.50');
    expect(parsed.category).toBe('RFG');
    expect(parsed.costs.total).toBe(356.12);
  });

  it('handles line with no costs gracefully', () => {
    const parsed = parseLineToFields(line(2, 'General cleanup'));
    expect(parsed.costs.total).toBeNull();
    expect(parsed.description).toBe('General cleanup');
  });
});

describe('runDeterministicPrematch', () => {
  it('auto-matches identical lines with same description + costs + qty', () => {
    const yours = [
      line(1, 'RFG Remove Comp. shingles - 3 tab 14.50 SQ 24.56 356.12'),
      line(2, 'PLM Install copper pipe 10.00 LF 8.50 85.00'),
    ];
    const adj = [
      line(1, 'RFG Remove Comp. shingles - 3 tab 14.50 SQ 24.56 356.12'),
      line(2, 'PLM Install copper pipe 10.00 LF 8.50 85.00'),
    ];

    const result = runDeterministicPrematch(yours, adj);
    expect(result.stats.autoMatchedCount).toBe(2);
    expect(result.unmatchedYourLines).toHaveLength(0);
    expect(result.unmatchedAdjusterLines).toHaveLength(0);
  });

  it('does NOT auto-match lines with different costs', () => {
    const yours = [
      line(1, 'RFG Remove Comp. shingles - 3 tab 14.50 SQ 24.56 356.12'),
    ];
    const adj = [
      line(1, 'RFG Remove Comp. shingles - 3 tab 14.50 SQ 24.56 999.99'),
    ];

    const result = runDeterministicPrematch(yours, adj);
    // Should NOT match because total cost differs significantly
    expect(result.stats.autoMatchedCount).toBe(0);
    expect(result.unmatchedYourLines).toHaveLength(1);
    expect(result.unmatchedAdjusterLines).toHaveLength(1);
  });

  it('does NOT auto-match lines with different quantities', () => {
    const yours = [
      line(1, 'PLM Install copper pipe 10.00 LF 8.50 85.00'),
    ];
    const adj = [
      line(1, 'PLM Install copper pipe 20.00 LF 8.50 170.00'),
    ];

    const result = runDeterministicPrematch(yours, adj);
    expect(result.stats.autoMatchedCount).toBe(0);
  });

  it('does NOT auto-match lines with very different descriptions', () => {
    const yours = [
      line(1, 'RFG Remove Comp. shingles 14.50 SQ 24.56 356.12'),
    ];
    const adj = [
      line(1, 'PLM Install copper pipe 14.50 SQ 24.56 356.12'),
    ];

    const result = runDeterministicPrematch(yours, adj);
    expect(result.stats.autoMatchedCount).toBe(0);
  });

  it('enforces one-to-one matching', () => {
    const yours = [
      line(1, 'DRY Drywall - 1/2" 100.00 SF 0.85 85.00'),
      line(2, 'DRY Drywall - 1/2" 100.00 SF 0.85 85.00'),
    ];
    const adj = [
      line(1, 'DRY Drywall - 1/2" 100.00 SF 0.85 85.00'),
    ];

    const result = runDeterministicPrematch(yours, adj);
    // Only one pair can match (one-to-one)
    expect(result.stats.autoMatchedCount).toBe(1);
    expect(result.unmatchedYourLines).toHaveLength(1);
    expect(result.unmatchedAdjusterLines).toHaveLength(0);
  });

  it('passes through non-scope lines untouched', () => {
    const yours = [
      line(1, 'Some header text'),
      line(2, 'RFG Remove shingles 14.50 SQ 24.56 356.12'),
    ];
    const adj = [
      line(1, 'Different header'),
      line(2, 'RFG Remove shingles 14.50 SQ 24.56 356.12'),
    ];

    const result = runDeterministicPrematch(yours, adj);
    expect(result.stats.autoMatchedCount).toBe(1);
    // Both headers should be in unmatched
    expect(result.unmatchedYourLines.some((l) => l.text === 'Some header text')).toBe(true);
    expect(result.unmatchedAdjusterLines.some((l) => l.text === 'Different header')).toBe(true);
  });
});

describe('deterministicMatchesToRawLineItems', () => {
  it('converts matches to RawLineItem shape with MATCH status', () => {
    const yours = [line(1, 'RFG Remove shingles 14.50 SQ 24.56 356.12')];
    const adj = [line(1, 'RFG Remove shingles 14.50 SQ 24.56 356.12')];

    const result = runDeterministicPrematch(yours, adj);
    const items = deterministicMatchesToRawLineItems(result.matches);
    expect(items).toHaveLength(1);
    expect(items[0]!.matchStatus).toBe('MATCH');
    expect(items[0]!.totalYours).toBe(356.12);
    expect(items[0]!.totalAdjuster).toBe(356.12);
    expect(items[0]!.diffAmount).toBe(0);
    expect(items[0]!.category).toBe('RFG');
  });
});
