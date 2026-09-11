import { describe, expect, it } from 'vitest';
import { scoreNameFn, getSoundProfile } from './nameScoring';

describe('scoreNameFn', () => {
  it('returns 0 scores for empty input', () => {
    expect(scoreNameFn('')).toEqual({ phonetic: 0, trademark: 0, domain: 0, category: 0 });
  });

  it('scores a short brandable name', () => {
    const scores = scoreNameFn('Nomad');
    expect(scores.phonetic).toBeGreaterThanOrEqual(45);
    expect(scores.phonetic).toBeLessThanOrEqual(99);
    expect(scores.trademark).toBeGreaterThanOrEqual(40);
    expect(scores.domain).toBeGreaterThanOrEqual(31);
    expect(scores.category).toBeGreaterThanOrEqual(72);
  });

  it('penalizes clichéd roots for trademark score', () => {
    const nice = scoreNameFn('CloudNova');
    expect(nice.trademark).toBeLessThan(scoreNameFn('Nova').trademark);
  });
});

describe('getSoundProfile', () => {
  it('returns balanced/empty profile for empty input', () => {
    expect(getSoundProfile('')).toEqual({ cue: 'balanced', label: 'Balanced', traits: [] });
  });

  it('classifies front-vowel + fricative names as fast-light', () => {
    // "Fizzi": f/z/z fricatives, i/i front vowels
    expect(getSoundProfile('Fizzi').cue).toBe('fast-light');
  });

  it('classifies back-vowel + plosive names as strong-grounded', () => {
    // "Bogot": b/g/t plosives, o/o back vowels
    expect(getSoundProfile('Bogot').cue).toBe('strong-grounded');
  });

  it('flags trait letters', () => {
    expect(getSoundProfile('Vexor').traits).toContain('energetic');
    expect(getSoundProfile('Torvim').traits).toContain('reliable');
  });
});
