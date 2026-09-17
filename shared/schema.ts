import { pgTable, text, timestamp, integer } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  createdAt: timestamp('created_at').defaultNow(),
  // Server-side paywall enforcement (previously client-only — see the
  // predeploy-security-audit finding it fixes). freeReportsUsed counts
  // against FREE_SEARCH_LIMIT; paidCredits decrements per generation once
  // that's exhausted; an active Pro subscription bypasses both (checked live
  // against stripe.subscriptions, not stored here).
  freeReportsUsed: integer('free_reports_used').notNull().default(0),
  paidCredits: integer('paid_credits').notNull().default(0),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Idempotency guard for the Stripe webhook's credit-grant logic (predeploy-
// security-audit finding). Stripe delivers webhooks at-least-once and retries
// on any slow response or transient failure — without this, a retried
// checkout.session.completed event would grant the 10-search pack again for
// the same purchase. One row per successfully-credited checkout session id;
// the webhook handler only grants credits when inserting here doesn't
// conflict (onConflictDoNothing), guaranteeing exactly-once regardless of how
// many times Stripe redelivers the same event.
export const creditGrants = pgTable('credit_grants', {
  checkoutSessionId: text('checkout_session_id').primaryKey(),
  createdAt: timestamp('created_at').defaultNow(),
});

export type CreditGrant = typeof creditGrants.$inferSelect;
