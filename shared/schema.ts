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

export const feedback = pgTable('feedback', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  email: text('email'),
  message: text('message').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export type Feedback = typeof feedback.$inferSelect;
export type InsertFeedback = typeof feedback.$inferInsert;
