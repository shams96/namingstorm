/**
 * Pure name-parsing helpers extracted from App.tsx so they can be unit-tested
 * directly without rendering the component. Behavior is identical to the inline
 * implementations.
 */

/** Extract generated brand names from a `## NAME_n: <NAME>` markdown stream. */
export function parseNames(response: string): string[] {
  if (!response) return [];
  const matches = [...response.matchAll(/## NAME_\d+:\s*([^\n]+)/g)];
  return matches
    .map((m) => {
      const raw = m[1].trim();
      return raw.replace(/\*\*/g, '').replace(/`/g, '').trim();
    })
    .filter((n) => n.length > 0 && n.length <= 30);
}

/** Extract evolved variants from a `### VARIANT_n: <NAME>` markdown stream. */
export function parseEvolvedNames(response: string): string[] {
  if (!response) return [];
  const matches = [...response.matchAll(/### VARIANT_\d+:\s*([^\n]+)/g)];
  return matches
    .map((m) => m[1].trim().replace(/\*\*/g, '').replace(/`/g, '').trim())
    .filter((n) => n.length > 0 && n.length <= 30);
}

export interface NamePool {
  phase1: string[];
  phase2: string[];
  phase3: string[];
}

/**
 * Extract raw candidate name lists from a `/api/generate-pool` response, which
 * groups numbered candidates under `## PHASE_n_POOL` headers.
 */
export function parseNamePool(response: string): NamePool {
  const pool: NamePool = { phase1: [], phase2: [], phase3: [] };
  if (!response) return pool;

  const phaseKeys: (keyof NamePool)[] = ['phase1', 'phase2', 'phase3'];
  const sections = response.split(/## PHASE_(\d)_POOL/);
  // split produces: [preamble, '1', block1, '2', block2, '3', block3, ...]
  for (let i = 1; i < sections.length; i += 2) {
    const phaseNum = Number(sections[i]);
    const block = sections[i + 1] || '';
    const key = phaseKeys[phaseNum - 1];
    if (!key) continue;
    const names = [...block.matchAll(/^\s*\d+\.\s*([^\n]+)/gm)]
      .map((m) => m[1].trim().replace(/\*\*/g, '').replace(/`/g, '').replace(/[\[\]]/g, '').trim())
      .filter((n) => n.length > 0 && n.length <= 30);
    pool[key] = names;
  }
  return pool;
}

/**
 * Paywall gate predicate: after `freeLimit` free searches are used, generation
 * is gated behind an account + payment, unless the user is Pro or still has
 * paid search credits remaining.
 */
export function shouldShowPaywall(args: {
  freeReportsUsed: number;
  freeLimit: number;
  isPro: boolean;
  paidCredits: number;
}): boolean {
  return args.freeReportsUsed >= args.freeLimit && !args.isPro && args.paidCredits <= 0;
}
