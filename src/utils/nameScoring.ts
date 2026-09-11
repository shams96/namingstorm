// Sound-symbolism reference (per naming-agency research, e.g. Lexicon Branding):
// front vowels (i, e) + fricatives (f, s, v, z, h) read as small/fast/light;
// back vowels (o, u) + plosives (p, t, k, b, d, g) read as large/strong/grounded.
// https://www.theidbureau.com/blog/using-sound-symbolism
const FRONT_VOWELS = new Set(['i', 'e']);
const BACK_VOWELS = new Set(['o', 'u']);
const PLOSIVES = new Set(['p', 't', 'k', 'b', 'd', 'g']);
const FRICATIVES = new Set(['f', 's', 'v', 'z', 'h']);

export interface SoundProfile {
  cue: 'fast-light' | 'strong-grounded' | 'balanced';
  label: string;
  traits: string[];
}

// Deterministic phoneme-attribute scorer — grounded in published sound-symbolism
// research rather than an LLM's prose "phonetic rules", so results are consistent
// and don't depend on a model re-grading its own output each run.
export const getSoundProfile = (name: string): SoundProfile => {
  const c = name.toLowerCase().replace(/[^a-z]/g, '');
  if (!c) return { cue: 'balanced', label: 'Balanced', traits: [] };

  let vowelBalance = 0, vowelCount = 0;
  let consonantBalance = 0, consonantCount = 0;

  for (const ch of c) {
    if (FRONT_VOWELS.has(ch)) { vowelBalance += 1; vowelCount++; }
    else if (BACK_VOWELS.has(ch)) { vowelBalance -= 1; vowelCount++; }
    if (PLOSIVES.has(ch)) { consonantBalance -= 1; consonantCount++; }
    else if (FRICATIVES.has(ch)) { consonantBalance += 1; consonantCount++; }
  }

  const traits: string[] = [];
  if (c.includes('v')) traits.push('energetic');
  if (/^[bt]/.test(c)) traits.push('reliable');
  if (/[xz]/.test(c)) traits.push('distinctive');

  const vb = vowelCount ? vowelBalance / vowelCount : 0;
  const cb = consonantCount ? consonantBalance / consonantCount : 0;

  let cue: SoundProfile['cue'] = 'balanced';
  let label = 'Balanced';
  if (vb > 0.2 && cb > 0.2) { cue = 'fast-light'; label = 'Fast & Light'; }
  else if (vb < -0.2 && cb < -0.2) { cue = 'strong-grounded'; label = 'Strong & Grounded'; }

  return { cue, label, traits };
};

export const scoreNameFn = (name: string) => {
  const c = name.toLowerCase().replace(/[^a-z]/g, '');
  if (!c) return { phonetic: 0, trademark: 0, domain: 0, category: 0 };

  const syllables = Math.max(1, (c.match(/[aeiou]+/g) || []).length);
  let phonetic = 95 - Math.max(0, (syllables - 2) * 14);
  const clusters = (c.match(/[^aeiou]{3,}/g) || []).length;
  phonetic -= clusters * 12;
  if (/^[ktxbdgp]/i.test(c)) phonetic += 3;
  phonetic = Math.max(45, Math.min(99, phonetic));

  let trademark = 75 + (c.length <= 7 ? 15 : 0);
  const clicheRoots = ['tech', 'net', 'hub', 'link', 'core', 'sync', 'cloud', 'smart', 'fast', 'data'];
  if (clicheRoots.some(r => c.includes(r))) trademark -= 20;
  if (/[xzq]/.test(c)) trademark += 8;
  trademark = Math.max(40, Math.min(98, trademark));

  const domain = c.length >= 8 ? 91 : c.length >= 7 ? 81 : c.length >= 6 ? 67 : c.length >= 5 ? 51 : 31;
  const hash = c.split('').reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) & 0xffff, 0);
  const category = 72 + (hash % 20);

  return { phonetic, trademark, domain, category };
}
