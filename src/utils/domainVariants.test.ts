import { describe, expect, it } from 'vitest';
import { generateDomainVariants } from './domainVariants';

describe('generateDomainVariants', () => {
  it('generates a La-prefixed variant', () => {
    const variants = generateDomainVariants('acme');
    expect(variants).toContainEqual({ name: 'laacme', technique: 'prefix-la' });
  });

  it('skips the La prefix when the name already starts with la', () => {
    const variants = generateDomainVariants('lacme');
    expect(variants.find((v) => v.technique === 'prefix-la')).toBeUndefined();
  });

  it('doubles the last consonant', () => {
    const variants = generateDomainVariants('acme');
    expect(variants).toContainEqual({ name: 'acmme', technique: 'double-letter' });
  });

  it('appends a trailing e when the name does not already end in e', () => {
    const variants = generateDomainVariants('acme');
    expect(variants.find((v) => v.technique === 'suffix-e')).toBeUndefined();

    const variants2 = generateDomainVariants('acm');
    expect(variants2).toContainEqual({ name: 'acme', technique: 'suffix-e' });
  });

  it('appends a trailing s when the name does not already end in s', () => {
    const variants = generateDomainVariants('acme');
    expect(variants).toContainEqual({ name: 'acmes', technique: 'suffix-s' });
  });

  it('skips the trailing s when the name already ends in s', () => {
    const variants = generateDomainVariants('boots');
    expect(variants.find((v) => v.technique === 'suffix-s')).toBeUndefined();
  });

  it('returns an empty array for an empty name', () => {
    expect(generateDomainVariants('')).toEqual([]);
  });
});
