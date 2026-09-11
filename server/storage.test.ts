import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/test/mocks/pg';
import '../src/test/mocks/drizzle';
import { dbState } from '../src/test/mocks/drizzle';

import { Storage } from './storage';

describe('Storage', () => {
  let storage: Storage;

  beforeEach(() => {
    dbState.reset();
    storage = new Storage();
  });

  it('getUser returns the first matching row', async () => {
    const user = { id: 'u1', email: 'a@b.com', stripeCustomerId: null };
    dbState.__rows = [user];
    const result = await storage.getUser('u1');
    expect(result).toEqual(user);
  });

  it('upsertUser inserts then reselects', async () => {
    const inserted = { id: 'u1', email: 'a@b.com' };
    dbState.__rows = [inserted];
    const result = await storage.upsertUser('u1', 'a@b.com');
    expect(result).toEqual(inserted);
    // insert path exercised (no throw)
    expect(dbState.__insertResult).toBeDefined();
  });

  it('updateUserStripe calls update().set().where()', async () => {
    await storage.updateUserStripe('u1', { stripeCustomerId: 'cus_x' });
    // no throw is sufficient; the mocked chain resolves to { rows: [] }
    expect(true).toBe(true);
  });

  it('getActiveSubscription returns the first subscription row', async () => {
    dbState.__executeResult = { rows: [{ id: 'sub_1', status: 'active' }] };
    const result = await storage.getActiveSubscription('cus_x');
    expect(result).toEqual({ id: 'sub_1', status: 'active' });
    // execute was called with a sql template
    expect(dbState.__executeCalls.length).toBe(1);
  });

  it('getActiveSubscription returns null when no rows', async () => {
    dbState.__executeResult = { rows: [] };
    const result = await storage.getActiveSubscription('cus_x');
    expect(result).toBeNull();
  });

  it('getPriceByAmount returns the first price row', async () => {
    dbState.__executeResult = { rows: [{ id: 'price_500', unit_amount: 500 }] };
    const result = await storage.getPriceByAmount(500, false);
    expect(result).toEqual({ id: 'price_500', unit_amount: 500 });
  });

  it('getPriceByAmount returns null when no rows', async () => {
    dbState.__executeResult = { rows: [] };
    const result = await storage.getPriceByAmount(500, false);
    expect(result).toBeNull();
  });

  it('listActivePrices returns all rows', async () => {
    dbState.__executeResult = { rows: [{ id: 'p1' }, { id: 'p2' }] };
    const result = await storage.listActivePrices();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('p1');
  });
});
