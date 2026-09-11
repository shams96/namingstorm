/**
 * When the exact-match .com is taken, suggest brandable variants using the
 * same techniques real startups use to land on an available domain: a "La"
 * prefix (Romance-language convention, e.g. La Croix), doubling a consonant
 * (e.g. Reddit, Fitbit), or a vowel-suffix tail (e.g. Lyft/Fiverr-style, but
 * additive rather than subtractive: a trailing "e" or "s").
 *
 * Each variant is skipped when it would be redundant (e.g. don't suffix "s"
 * onto a name that already ends in "s").
 */
export interface DomainVariant {
  name: string;
  technique: 'prefix-la' | 'double-letter' | 'suffix-e' | 'suffix-s';
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

export function generateDomainVariants(baseName: string): DomainVariant[] {
  const name = baseName.toLowerCase().trim();
  if (!name) return [];

  const variants: DomainVariant[] = [];

  if (!name.startsWith('la')) {
    variants.push({ name: `la${name}`, technique: 'prefix-la' });
  }

  // Double the last consonant so the result still reads as one word
  // (e.g. "acme" -> "acmme"), skipping names with no consonant to double.
  for (let i = name.length - 1; i >= 0; i--) {
    const char = name[i];
    if (/[a-z]/.test(char) && !VOWELS.has(char)) {
      const doubled = name.slice(0, i + 1) + char + name.slice(i + 1);
      variants.push({ name: doubled, technique: 'double-letter' });
      break;
    }
  }

  if (!name.endsWith('e')) {
    variants.push({ name: `${name}e`, technique: 'suffix-e' });
  }

  if (!name.endsWith('s')) {
    variants.push({ name: `${name}s`, technique: 'suffix-s' });
  }

  return variants;
}
