import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

vi.mock('./firebase', () => ({
  auth: {},
  db: {},
  loginWithGoogle: vi.fn(),
  logout: vi.fn(),
  handleFirestoreError: vi.fn(),
  OperationType: { WRITE: 'WRITE' },
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

import App from './App';

describe('App', () => {
  it('renders the hero title and primary actions', () => {
    render(<App />);

    expect(screen.getByText(/NamingStorm: The AI/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Initialize Console/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Try as Guest/i })).toHaveLength(2);
  });
});
