import { vi } from 'vitest';

vi.mock('pg', () => {
  function Pool(this: any) {
    this.connect = vi.fn();
    this.query = vi.fn();
    this.end = vi.fn();
    this.on = vi.fn();
  }
  return { default: { Pool }, __esModule: true };
});
