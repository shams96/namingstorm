// Importing this module applies ALL external-service vi.mock factories for
// server route tests (drizzle, pg, stripe, stripe-replit-sync, @google/genai,
// firebase-admin). Each mock module has its vi.mock calls at the top level so
// Vitest hoists them above the `server` import. Import this BEFORE importing
// `server`/`server.ts`. The global `fetch` stub is applied separately via
// applyFetchMock() in test setup (it's request-time, not import-time).
import './drizzle';
import './pg';
import './stripe';
import './gemini';
import './firebase-admin';

import { dbState } from './drizzle';
import { stripeState } from './stripe';
import { geminiState } from './gemini';
import { firebaseState } from './firebase-admin';
import { fetchState } from './fetch';

export { dbState, stripeState, geminiState, firebaseState, fetchState };
export { applyFetchMock } from './fetch';

export function resetServerMockState() {
  dbState.reset();
  stripeState.reset();
  geminiState.reset();
  firebaseState.reset();
  fetchState.reset();
}
