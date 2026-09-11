import { describe, expect, it } from 'vitest';
import { parseNames, parseEvolvedNames, parseNamePool, shouldShowPaywall } from './parseNames';

describe('parseNames', () => {
  it('returns [] for empty input', () => {
    expect(parseNames('')).toEqual([]);
  });

  it('extracts names from ## NAME_n: headers', () => {
    const response = `## NAME_1: FOO\n## NAME_2: BAR\n## NAME_3: BAZ`;
    expect(parseNames(response)).toEqual(['FOO', 'BAR', 'BAZ']);
  });

  it('strips ** and backticks from extracted names', () => {
    const response = '## NAME_1: **FOO**\n## NAME_2: `BAR`';
    expect(parseNames(response)).toEqual(['FOO', 'BAR']);
  });

  it('filters out empty and over-30-char names', () => {
    const long = 'A'.repeat(31);
    const response = `## NAME_1: \n## NAME_2: ${long}\n## NAME_3: ZAP`;
    expect(parseNames(response)).toEqual(['ZAP']);
  });

  it('ignores non-NAME headers', () => {
    const response = `### VARIANT_1: NOPE\n## NAME_1: YES`;
    expect(parseNames(response)).toEqual(['YES']);
  });
});

describe('parseEvolvedNames', () => {
  it('returns [] for empty input', () => {
    expect(parseEvolvedNames('')).toEqual([]);
  });

  it('extracts variants from ### VARIANT_n: headers', () => {
    const response = `### VARIANT_1: ZAP\n### VARIANT_2: ZIP\n### VARIANT_3: ZOP`;
    expect(parseEvolvedNames(response)).toEqual(['ZAP', 'ZIP', 'ZOP']);
  });

  it('strips ** and backticks and filters by length', () => {
    const long = 'B'.repeat(35);
    const response = `### VARIANT_1: **ZAP**\n### VARIANT_2: ${long}`;
    expect(parseEvolvedNames(response)).toEqual(['ZAP']);
  });
});

describe('parseNamePool', () => {
  it('returns empty arrays for empty input', () => {
    expect(parseNamePool('')).toEqual({ phase1: [], phase2: [], phase3: [] });
  });

  it('extracts numbered candidates per phase section', () => {
    const response = `## PHASE_1_POOL
1. ALPHA
2. BETA

## PHASE_2_POOL
1. GAMMA
2. DELTA

## PHASE_3_POOL
1. EPSILON`;
    expect(parseNamePool(response)).toEqual({
      phase1: ['ALPHA', 'BETA'],
      phase2: ['GAMMA', 'DELTA'],
      phase3: ['EPSILON'],
    });
  });

  it('strips markdown formatting and brackets from candidates', () => {
    const response = `## PHASE_1_POOL
1. **[ALPHA]**
2. \`BETA\``;
    expect(parseNamePool(response).phase1).toEqual(['ALPHA', 'BETA']);
  });

  it('ignores an unrecognized phase number', () => {
    const response = `## PHASE_9_POOL
1. NOPE

## PHASE_1_POOL
1. YES`;
    expect(parseNamePool(response)).toEqual({ phase1: ['YES'], phase2: [], phase3: [] });
  });
});

describe('shouldShowPaywall', () => {
  it('shows paywall once the free limit is reached with no pro/paid credits', () => {
    expect(shouldShowPaywall({ freeReportsUsed: 5, freeLimit: 5, isPro: false, paidCredits: 0 })).toBe(true);
  });

  it('does not show paywall while free searches remain', () => {
    expect(shouldShowPaywall({ freeReportsUsed: 4, freeLimit: 5, isPro: false, paidCredits: 0 })).toBe(false);
  });

  it('does not show paywall when user is Pro', () => {
    expect(shouldShowPaywall({ freeReportsUsed: 5, freeLimit: 5, isPro: true, paidCredits: 0 })).toBe(false);
  });

  it('does not show paywall while paid credits remain', () => {
    expect(shouldShowPaywall({ freeReportsUsed: 5, freeLimit: 5, isPro: false, paidCredits: 3 })).toBe(false);
  });
});
