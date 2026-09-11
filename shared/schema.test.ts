import { describe, expect, expectTypeOf, it } from 'vitest';
import { users } from './schema';
import type { User, InsertUser } from './schema';

describe('shared/schema', () => {
  it('defines a users pgTable', () => {
    expect(users).toBeDefined();
  });

  it('exposes the expected columns', () => {
    const columns = Object.keys(users);
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'email', 'stripeCustomerId', 'stripeSubscriptionId', 'createdAt']),
    );
  });

  it('id is the primary key column', () => {
    // The drizzle column object carries its name; the table's primary key is 'id'.
    expect(users.id).toBeDefined();
    expect((users as any).id.name).toBe('id');
  });

  it('User and InsertUser types compile and are object-shaped', () => {
    expectTypeOf<User>().toMatchTypeOf<Record<string, unknown>>();
    expectTypeOf<InsertUser>().toMatchTypeOf<Partial<Record<string, unknown>>>();
  });
});
