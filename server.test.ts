import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
// Importing the mocks module applies all vi.mock factories (hoisted above the
// server import below). Must come before `import { buildApp } from './server'`.
import './src/test/mocks';
import { resetServerMockState, applyFetchMock, dbState, geminiState, stripeState, firebaseState, fetchState } from './src/test/mocks';

import { buildApp } from './server';

const GUEST_ID = 'guest-abcdef123456';
const VALID_BEARER = 'Bearer valid-token';

let app: import('express').Application;

beforeAll(() => {
  // Stub global fetch (request-time only). Applied once; reset per-test below.
  applyFetchMock();
});

beforeEach(async () => {
  resetServerMockState();
  app = await buildApp();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('/api/health', () => {
  it('returns 200 { status: "ok" }', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('verifyAuth middleware', () => {
  it('accepts a guest x-guest-id header and sets req.user as guest', async () => {
    const res = await request(app)
      .get('/api/stripe/status')
      .set('x-guest-id', GUEST_ID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false, plan: null });
  });

  it('rejects missing Authorization with 401', async () => {
    const res = await request(app).get('/api/stripe/status');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized: Missing or invalid token' });
  });

  it('rejects an invalid Bearer token via firebase', async () => {
    firebaseState.verifyShouldThrow = true;
    const res = await request(app).get('/api/stripe/status').set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized: Invalid token' });
  });

  it('accepts a valid Bearer token and sets req.user', async () => {
    firebaseState.decodedToken = { uid: 'uid-real', email: 'real@example.com' };
    const res = await request(app).get('/api/stripe/status').set('Authorization', VALID_BEARER);
    expect(res.status).toBe(200);
    // status route queries db for the user; no customer → inactive
    expect(res.body).toEqual({ active: false, plan: null });
  });
});

describe('/api/generate', () => {
  const baseBody = {
    productDescription: 'A test product',
    targetAudience: 'devs',
    thinkingLevel: 50,
  };

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/generate')
      .set('x-guest-id', GUEST_ID)
      .send({ productDescription: 'only one' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
  });

  it('returns 500 API_KEY_MISSING when env keys are absent', async () => {
    const savedKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    const savedUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    try {
      const res = await request(app)
        .post('/api/generate')
        .set('x-guest-id', GUEST_ID)
        .send(baseBody);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'API_KEY_MISSING' });
    } finally {
      process.env.AI_INTEGRATIONS_GEMINI_API_KEY = savedKey;
      process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = savedUrl;
    }
  });

  it('streams SSE chunks and ends with data: [DONE]', async () => {
    geminiState.chunks = ['## NAME_1: FOO\n', '## NAME_2: BAR\n'];
    const res = await request(app)
      .post('/api/generate')
      .set('x-guest-id', GUEST_ID)
      .send(baseBody);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('data: ');
    expect(res.text).toContain('## NAME_1: FOO');
    expect(res.text).toContain('## NAME_2: BAR');
    expect(res.text).toContain('data: [DONE]');
  });

  it('emits an SSE error event when the stream throws after headers sent', async () => {
    geminiState.chunks = ['partial\n'];
    geminiState.error = new Error('boom');
    const res = await request(app)
      .post('/api/generate')
      .set('x-guest-id', GUEST_ID)
      .send(baseBody);
    expect(res.status).toBe(200);
    expect(res.text).toContain('partial');
    expect(res.text).toContain('"error":"boom"');
  });
});

describe('/api/evolve', () => {
  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/evolve')
      .set('x-guest-id', GUEST_ID)
      .send({ productDescription: 'p' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
  });

  it('streams evolved variants as SSE', async () => {
    geminiState.chunks = ['### VARIANT_1: ZAP\n', '### VARIANT_2: ZIP\n'];
    const res = await request(app)
      .post('/api/evolve')
      .set('x-guest-id', GUEST_ID)
      .send({ name: 'FOO', productDescription: 'p', targetAudience: 'a' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('### VARIANT_1: ZAP');
    expect(res.text).toContain('data: [DONE]');
  });
});

describe('/api/brand-story', () => {
  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/brand-story')
      .set('x-guest-id', GUEST_ID)
      .send({ productDescription: 'p' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
  });

  it('streams the brand story as SSE', async () => {
    geminiState.chunks = ['**TAGLINE:** Go.\n'];
    const res = await request(app)
      .post('/api/brand-story')
      .set('x-guest-id', GUEST_ID)
      .send({ name: 'FOO', productDescription: 'p' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('**TAGLINE:** Go.');
    expect(res.text).toContain('data: [DONE]');
  });
});

describe('/api/check-domain', () => {
  it('returns 400 when name is missing', async () => {
    const res = await request(app).get('/api/check-domain');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name required' });
  });

  it('returns 400 for an invalid name (no [a-z0-9-])', async () => {
    const res = await request(app).get('/api/check-domain?name=!!!');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid name' });
  });

  it('reports available=true when RDAP returns 404', async () => {
    fetchState.set('rdap.verisign.com', 404, {});
    const res = await request(app).get('/api/check-domain?name=foobar');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ domain: 'foobar.com', available: true });
  });

  it('reports available=false when RDAP returns 200', async () => {
    fetchState.set('rdap.verisign.com', 200, { some: 'data' });
    const res = await request(app).get('/api/check-domain?name=foobar');
    expect(res.body).toEqual({ domain: 'foobar.com', available: false });
  });

  it('reports available=null for other RDAP statuses', async () => {
    fetchState.set('rdap.verisign.com', 500, {});
    const res = await request(app).get('/api/check-domain?name=foobar');
    expect(res.body).toEqual({ domain: 'foobar.com', available: null });
  });

  it('reports available=null when fetch throws', async () => {
    fetchState.setThrow('rdap.verisign.com');
    const res = await request(app).get('/api/check-domain?name=foobar');
    expect(res.body).toEqual({ domain: 'foobar.com', available: null });
  });
});

describe('/api/stripe/checkout', () => {
  it('returns 404 when no price row is found', async () => {
    dbState.__executeResult = { rows: [] };
    const res = await request(app)
      .post('/api/stripe/checkout')
      .set('x-guest-id', GUEST_ID)
      .send({ plan: 'report' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Pricing not set up yet. Please contact support.' });
  });

  it('returns a checkout url for a guest when a price row exists', async () => {
    dbState.__executeResult = { rows: [{ id: 'price_500' }] };
    const res = await request(app)
      .post('/api/stripe/checkout')
      .set('x-guest-id', GUEST_ID)
      .send({ plan: 'report' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://checkout.example/session_123' });
  });

  it('creates a Stripe customer for a logged-in user with no existing customer', async () => {
    firebaseState.decodedToken = { uid: 'uid-real', email: 'real@example.com' };
    dbState.__executeResult = { rows: [{ id: 'price_1200' }] };
    // user lookup returns no existing customer → triggers customers.create
    dbState.__rows = [];
    const res = await request(app)
      .post('/api/stripe/checkout')
      .set('Authorization', VALID_BEARER)
      .send({ plan: 'pro' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://checkout.example/session_123' });
    // insert().values(...).onConflictDoUpdate(...) should have been called
    expect(dbState.__insertResult).toBeDefined();
  });

  it('reuses an existing customer id for a logged-in user', async () => {
    firebaseState.decodedToken = { uid: 'uid-real', email: 'real@example.com' };
    dbState.__executeResult = { rows: [{ id: 'price_500' }] };
    dbState.__rows = [{ id: 'uid-real', stripeCustomerId: 'cus_existing' }];
    const res = await request(app)
      .post('/api/stripe/checkout')
      .set('Authorization', VALID_BEARER)
      .send({ plan: 'report' });
    expect(res.status).toBe(200);
  });
});

describe('/api/stripe/status', () => {
  it('returns inactive for a guest', async () => {
    const res = await request(app).get('/api/stripe/status').set('x-guest-id', GUEST_ID);
    expect(res.body).toEqual({ active: false, plan: null });
  });

  it('returns inactive for a logged-in user with no customer', async () => {
    firebaseState.decodedToken = { uid: 'uid-real', email: 'real@example.com' };
    dbState.__rows = [];
    const res = await request(app).get('/api/stripe/status').set('Authorization', VALID_BEARER);
    expect(res.body).toEqual({ active: false, plan: null });
  });

  it('returns active pro when an active subscription row is found', async () => {
    firebaseState.decodedToken = { uid: 'uid-real', email: 'real@example.com' };
    dbState.__rows = [{ id: 'uid-real', stripeCustomerId: 'cus_existing' }];
    dbState.__executeResult = { rows: [{ id: 'sub_1' }] };
    const res = await request(app).get('/api/stripe/status').set('Authorization', VALID_BEARER);
    expect(res.body).toEqual({ active: true, plan: 'pro' });
  });
});

describe('/api/stripe/portal', () => {
  it('returns 403 for a guest', async () => {
    const res = await request(app).post('/api/stripe/portal').set('x-guest-id', GUEST_ID);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Sign in to manage billing' });
  });

  it('returns 404 when the user has no customer', async () => {
    firebaseState.decodedToken = { uid: 'uid-real', email: 'real@example.com' };
    dbState.__rows = [];
    const res = await request(app).post('/api/stripe/portal').set('Authorization', VALID_BEARER);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'No billing account found' });
  });

  it('returns a portal url when the user has a customer', async () => {
    firebaseState.decodedToken = { uid: 'uid-real', email: 'real@example.com' };
    dbState.__rows = [{ id: 'uid-real', stripeCustomerId: 'cus_existing' }];
    const res = await request(app).post('/api/stripe/portal').set('Authorization', VALID_BEARER);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://portal.example/session_456' });
  });
});

describe('/api/stripe/webhook', () => {
  it('returns 400 when stripe-signature is missing', async () => {
    const res = await request(app)
      .post('/api/stripe/webhook')
      .set('Content-Type', 'application/json')
      .send({ id: 'evt_1' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing stripe-signature header' });
  });

  it('returns 400 when STRIPE_WEBHOOK_SECRET is unset', async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const res = await request(app)
        .post('/api/stripe/webhook')
        .set('stripe-signature', 't=1,v1=abc')
        .send({ id: 'evt_1' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Webhook secret not configured' });
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });

  it('delegates a raw Buffer payload to sync.processWebhook and returns received:true', async () => {
    const payloadString = JSON.stringify({ id: 'evt_1' });
    let receivedBody: any;
    let receivedSig = '';
    stripeState.processWebhook = vi.fn(async (body: Buffer, sig: string) => {
      receivedBody = body;
      receivedSig = sig;
    });
    const res = await request(app)
      .post('/api/stripe/webhook')
      .set('stripe-signature', 't=1,v1=abc')
      .set('Content-Type', 'application/json')
      .send(payloadString);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    // The critical ordering invariant: the webhook handler receives a Buffer
    // (raw bytes), not parsed JSON, because the route is registered before
    // express.json().
    expect(Buffer.isBuffer(receivedBody)).toBe(true);
    expect(receivedBody.toString()).toBe(payloadString);
    expect(receivedSig).toBe('t=1,v1=abc');
    expect(stripeState.processWebhook).toHaveBeenCalledTimes(1);
  });

  it('returns 400 with the error message when processWebhook throws', async () => {
    stripeState.processWebhook = vi.fn(async () => {
      throw new Error('bad signature');
    });
    const res = await request(app)
      .post('/api/stripe/webhook')
      .set('stripe-signature', 't=1,v1=abc')
      .set('Content-Type', 'application/json')
      .send('{"id":"evt_1"}');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad signature' });
  });
});
