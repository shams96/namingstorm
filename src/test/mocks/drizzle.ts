import { vi } from 'vitest';

// vi.hoisted ensures these state objects are initialized before the vi.mock
// factory closures run (factories are hoisted above imports).
const hoisted = vi.hoisted(() => {
  const dbState = {
    __rows: [] as any[],
    __insertResult: { rows: [] as any[] },
    __executeResult: { rows: [] as any[] },
    __executeCalls: [] as any[],
    reset() {
      dbState.__rows = [];
      dbState.__insertResult = { rows: [] };
      dbState.__executeResult = { rows: [] };
      dbState.__executeCalls = [];
    },
  };
  return { dbState };
});

export const dbState = hoisted.dbState;

vi.mock('drizzle-orm/node-postgres', () => {
  const chainSelect = () => ({
    from: vi.fn(() => chainSelect()),
    where: vi.fn(async () => dbState.__rows),
  });
  const chainInsert = () => ({
    values: vi.fn(() => chainInsert()),
    onConflictDoUpdate: vi.fn(async () => dbState.__insertResult),
    onConflictDoNothing: vi.fn(async () => dbState.__insertResult),
  });
  const chainUpdate = () => ({
    set: vi.fn(() => chainUpdate()),
    where: vi.fn(async () => ({ rows: [] })),
  });
  const mockDb = {
    select: vi.fn(() => chainSelect()),
    insert: vi.fn(() => chainInsert()),
    update: vi.fn(() => chainUpdate()),
    execute: vi.fn(async (...args: any[]) => {
      dbState.__executeCalls.push(args);
      return dbState.__executeResult;
    }),
  };
  return { drizzle: vi.fn(() => mockDb) };
});
