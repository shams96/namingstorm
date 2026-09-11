import { vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  stripeState: {
    checkoutUrl: 'https://checkout.example/session_123',
    portalUrl: 'https://portal.example/session_456',
    customerId: 'cus_test_abc',
    processWebhook: vi.fn(async () => {}),
    reset() {
      hoisted.stripeState.processWebhook = vi.fn(async () => {});
    },
  },
}));

export const stripeState = hoisted.stripeState;

vi.mock('stripe', () => {
  // Use a function constructor so `new Stripe(key)` works (vi.fn impls that
  // return object literals are not callable as constructors in Vitest 4).
  function Stripe(this: any, _key: string) {
    this.customers = {
      create: vi.fn(async () => ({ id: stripeState.customerId })),
    };
    this.checkout = {
      sessions: { create: vi.fn(async () => ({ url: stripeState.checkoutUrl })) },
    };
    this.billingPortal = {
      sessions: { create: vi.fn(async () => ({ url: stripeState.portalUrl })) },
    };
  }
  return { default: Stripe };
});

vi.mock('stripe-replit-sync', () => {
  class StripeSync {
    constructor(_config: any) {}
    async processWebhook(payload: Buffer, signature: string) {
      return stripeState.processWebhook(payload, signature);
    }
    findOrCreateManagedWebhook = vi.fn(async () => ({ webhook: { secret: 'whsec_test' } }));
    syncBackfill = vi.fn(async () => {});
  }
  return {
    StripeSync,
    runMigrations: vi.fn(async () => {}),
  };
});
