import pkg from 'pg';
const { Pool } = pkg;
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, eq } from 'drizzle-orm';
import { users } from '../shared/schema.js';

function getDb() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return drizzle(pool);
}

export class Storage {
  async getUser(id: string) {
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(id: string, email?: string) {
    const db = getDb();
    await db.insert(users).values({ id, email }).onConflictDoNothing();
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async updateUserStripe(userId: string, data: { stripeCustomerId?: string; stripeSubscriptionId?: string }) {
    const db = getDb();
    await db.update(users).set(data).where(eq(users.id, userId));
  }

  async getActiveSubscription(customerId: string) {
    const db = getDb();
    const result = await db.execute(
      sql`SELECT * FROM stripe.subscriptions WHERE customer = ${customerId} AND status = 'active' LIMIT 1`
    );
    return result.rows[0] || null;
  }

  async getPriceByAmount(unitAmount: number, recurring: boolean) {
    const db = getDb();
    // `recurring` is a jsonb column; Stripe syncs a JSON `null` (not SQL NULL) for
    // one-time prices, so both forms must be checked.
    const result = await db.execute(
      recurring
        ? sql`SELECT * FROM stripe.prices WHERE unit_amount = ${unitAmount} AND active = true AND recurring IS NOT NULL AND recurring <> 'null'::jsonb LIMIT 1`
        : sql`SELECT * FROM stripe.prices WHERE unit_amount = ${unitAmount} AND active = true AND (recurring IS NULL OR recurring = 'null'::jsonb) LIMIT 1`
    );
    return result.rows[0] || null;
  }

  async listActivePrices() {
    const db = getDb();
    const result = await db.execute(sql`SELECT * FROM stripe.prices WHERE active = true ORDER BY unit_amount`);
    return result.rows;
  }
}

export const storage = new Storage();
