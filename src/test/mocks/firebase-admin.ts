import { vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  firebaseState: {
    decodedToken: { uid: 'uid-test-123', email: 'tester@example.com', guest: false } as any,
    verifyShouldThrow: false,
    reset() {
      hoisted.firebaseState.decodedToken = {
        uid: 'uid-test-123',
        email: 'tester@example.com',
        guest: false,
      };
      hoisted.firebaseState.verifyShouldThrow = false;
    },
  },
}));

export const firebaseState = hoisted.firebaseState;

const verifyIdToken = vi.fn(async (_token: string) => {
  if (firebaseState.verifyShouldThrow) throw new Error('Invalid token');
  return firebaseState.decodedToken;
});

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(() => ({})),
  cert: vi.fn((c: any) => c),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({ verifyIdToken })),
}));
