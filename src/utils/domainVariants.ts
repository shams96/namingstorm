/**
 * When the exact-match .com is taken, suggest brandable variants using the
 * same techniques real startups use to land on an available domain: doubling
 * a consonant (e.g. Reddit, Fitbit), a vowel-suffix tail (e.g. Lyft/Fiverr-
 * style, but additive rather than subtractive: a trailing "e" or "s"), a
 * "Get"/"Try" prefix (common SaaS convention, e.g. GetSatisfaction), or a
 * "La" prefix (Romance-language convention, e.g. La Croix) — deliberately
 * tried LAST, not first: "la" + anything is almost never already registered,
 * so when the caller picks the first available candidate, "La-" would win
 * for virtually every name and every fallback would look identical (this
 * happened in production — a batch of "available alternative" suggestions
 * were ALL "La<word>", which reads as an obvious formula rather than a
 * considered brand name once a user sees more than one).
 *
 * Each variant is skipped when it would be redundant (e.g. don't suffix "s"
 * onto a name that already ends in "s").
 */
export interface DomainVariant {
  name: string;
  technique: 'double-letter' | 'suffix-e' | 'suffix-s' | 'prefix-get' | 'prefix-try' | 'prefix-la';
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

export function generateDomainVariants(baseName: string): DomainVariant[] {
  const name = baseName.toLowerCase().trim();
  if (!name) return [];

  const variants: DomainVariant[] = [];

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

  if (!name.startsWith('get')) {
    variants.push({ name: `get${name}`, technique: 'prefix-get' });
  }

  if (!name.startsWith('try')) {
    variants.push({ name: `try${name}`, technique: 'prefix-try' });
  }

  // Last resort — see comment above on why this is deliberately least-preferred.
  if (!name.startsWith('la')) {
    variants.push({ name: `la${name}`, technique: 'prefix-la' });
  }

  return variants;
}
