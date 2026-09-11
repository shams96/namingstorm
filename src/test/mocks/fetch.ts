import { vi } from 'vitest';

/**
 * Stub `global.fetch` with a queue of scripted responses. Each entry maps a
 * URL substring to either a response descriptor or an Error (network failure).
 * Tests build a fresh script per case and call applyFetchMock() in setup.
 */
export const fetchState = {
  script: new Map<string, { status?: number; json?: any; ok?: boolean } | Error>(),
  reset() {
    this.script.clear();
  },
  set(urlSubstring: string, status: number, json: any) {
    this.script.set(urlSubstring, { status, json, ok: status >= 200 && status < 300 });
  },
  setThrow(urlSubstring: string) {
    this.script.set(urlSubstring, new Error('network failure'));
  },
};

let applied = false;
export function applyFetchMock() {
  if (applied) return;
  applied = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, _init?: any) => {
      const u = String(url);
      for (const [key, value] of fetchState.script) {
        if (!u.includes(key)) continue;
        if (value instanceof Error) throw value;
        return {
          ok: value.ok,
          status: value.status,
          json: async () => value.json,
          text: async () => JSON.stringify(value.json),
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }),
  );
}
