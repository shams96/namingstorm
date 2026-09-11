import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import './test/app-mocks';
import { toast } from 'sonner';
import App from './App';

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, '', window.location.pathname);
  vi.clearAllMocks();
});

afterEach(() => {
  window.history.replaceState({}, '', window.location.pathname);
});

describe('App payment-success param handling', () => {
  it('sets sl_paid_credits and toasts on ?payment_success=report', () => {
    window.history.replaceState({}, '', '/?payment_success=report');
    render(<App />);
    expect(window.sessionStorage.getItem('sl_paid_credits')).toBe('10');
    expect(toast.success).toHaveBeenCalledTimes(1);
    // URL param cleared after handling.
    expect(window.location.search).toBe('');
  });

  it('sets isPro and toasts on ?payment_success=pro', () => {
    window.history.replaceState({}, '', '/?payment_success=pro');
    render(<App />);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('');
  });

  it('does nothing when no payment_success param is present', () => {
    render(<App />);
    expect(window.sessionStorage.getItem('sl_paid_credits')).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('App guest session storage', () => {
  it('renders the hero and guest actions without crashing', () => {
    const { getByText, getAllByRole } = render(<App />);
    expect(getByText(/NamingStorm: The AI/i)).toBeTruthy();
    expect(getAllByRole('button', { name: /Try as Guest/i })).toHaveLength(2);
  });
});
