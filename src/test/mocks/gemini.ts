import { vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  geminiState: {
    chunks: [] as string[],
    error: null as Error | null,
    lastRequest: null as any,
    reset() {
      hoisted.geminiState.chunks = [];
      hoisted.geminiState.error = null;
      hoisted.geminiState.lastRequest = null;
    },
  },
}));

export const geminiState = hoisted.geminiState;

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    constructor(config: any) {
      (this as any).__config = config;
    }
    models = {
      generateContentStream: vi.fn(async function* (this: any, request: any) {
        geminiState.lastRequest = request;
        for (const chunk of geminiState.chunks) {
          yield { text: chunk };
          if (geminiState.error) throw geminiState.error;
        }
        if (geminiState.error) throw geminiState.error;
      }),
    };
  }
  return { GoogleGenAI };
});
