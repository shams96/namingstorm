import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

describe('ErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <div>Safe content</div>
      </ErrorBoundary>
    );

    expect(screen.getByText('Safe content')).toBeInTheDocument();
  });

  it('renders fallback UI when a child throws an error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const Bomb = () => {
      throw new Error('Crash');
    };

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    expect(screen.getByText(/System Error/i)).toBeInTheDocument();
    expect(screen.getByText(/Crash/i)).toBeInTheDocument();

    consoleError.mockRestore();
  });
});
