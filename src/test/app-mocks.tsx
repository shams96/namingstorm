import { vi } from 'vitest';

/**
 * Shared vi.mock factories for App component tests. Importing this module
 * applies the mocks (hoisted) the same way as the existing App.test.tsx.
 * The motion/react mock uses JSX, so consumers must be .tsx files.
 */
vi.mock('../firebase', () => ({
  auth: {},
  db: {},
  loginWithGoogle: vi.fn(),
  logout: vi.fn(),
  handleFirestoreError: vi.fn(),
  OperationType: { WRITE: 'WRITE', GET: 'GET' },
}));

vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({})),
  GoogleAuthProvider: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn((auth: any, callback: any) => {
    callback(null);
    return () => {};
  }),
  User: class {},
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  addDoc: vi.fn(),
  onSnapshot: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  serverTimestamp: vi.fn(),
  doc: vi.fn(),
  setDoc: vi.fn(),
  getDoc: vi.fn().mockResolvedValue({ exists: () => false }),
  updateDoc: vi.fn(),
}));

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('motion/react', () => ({
  motion: {
    div: (props: any) => <div {...props} />,
    button: (props: any) => <button {...props} />,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));
