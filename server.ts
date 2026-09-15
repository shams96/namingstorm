import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import rateLimit from 'express-rate-limit';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { runMigrations, StripeSync } from 'stripe-replit-sync';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql as drizzleSql, eq as drizzleEq } from 'drizzle-orm';
import { users } from './shared/schema.js';
import { generateDomainVariants } from './src/utils/domainVariants.js';

// Must match App.tsx's copies (no shared module imported by both client and
// server today) — these gate the same paywall, client-side for UI state,
// here for the actual enforcement.
const FREE_SEARCH_LIMIT = 5;
const PAID_SEARCH_PACK_SIZE = 10;

// Stripe helpers (uses env vars directly — no connector needed)
export function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(key);
}

// Gemini returns transient 503 UNAVAILABLE ("high demand") and occasionally 429
// RESOURCE_EXHAUSTED errors that resolve themselves within seconds. Without any
// retry, every one of these blips surfaced straight to the user as "hit a snag."
// This wraps a single (non-streaming) Gemini call with bounded exponential-backoff
// retry, retrying ONLY on those transient statuses — anything else (bad request,
// auth, etc.) fails immediately since retrying won't help.
function isRetryableGeminiError(error: any): boolean {
  const status = error?.status ?? error?.error?.code;
  return status === 503 || status === 429 || error instanceof GeminiTimeoutError;
}

// The SDK call (or the underlying fetch to Google's API) can occasionally hang
// with no response and no rejection — neither a 503/429 nor any other error,
// just silence. Observed directly: a real /api/generate request sat open with
// headers already flushed and zero bytes written for 100+ seconds. Without a
// hard timeout here, that hang is unbounded — the client's own 25s idle-read
// timeout only covers reading bytes we've already sent, not the upstream call
// itself, so a server-side hang before the first byte defeats it entirely.
// gemini-3.5-flash also has genuine "thinking" latency before the first
// streamed token that legitimately runs 20-35s on this system-instruction-
// heavy prompt (measured directly, not a bug) — the threshold below must sit
// well above that or healthy requests get killed and retried into failure.
const GEMINI_CALL_TIMEOUT_MS = 60000;

class GeminiTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'GeminiTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new GeminiTimeoutError(label, ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function withGeminiRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTimeout(fn(), GEMINI_CALL_TIMEOUT_MS, 'Gemini call');
    } catch (error: any) {
      lastError = error;
      if (!isRetryableGeminiError(error) || attempt === maxAttempts) throw error;
      const delayMs = 1000 * 2 ** (attempt - 1); // 1s, 2s
      console.warn(`Gemini call failed (attempt ${attempt}/${maxAttempts}, ${error instanceof GeminiTimeoutError ? 'timeout' : 'transient'}) — retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// Same idea for streaming calls, where the transient error (or hang — see
// GEMINI_CALL_TIMEOUT_MS above) can surface either before the stream starts or
// partway through iteration. Both the initial connect and each chunk read are
// individually bounded, since a hang can occur at either point. We can only
// safely retry if nothing has been written to the client yet — once real
// content has streamed out, restarting would duplicate/corrupt what the client
// already has, so at that point we let the error propagate to the existing SSE
// error handler.
async function streamGeminiWithRetry(
  createStream: () => Promise<AsyncIterable<{ text?: string }>>,
  onChunk: (text: string) => void,
  maxAttempts = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let wroteAny = false;
    try {
      const stream = await withTimeout(createStream(), GEMINI_CALL_TIMEOUT_MS, 'Gemini stream connect');
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const { value, done } = await withTimeout(iterator.next(), GEMINI_CALL_TIMEOUT_MS, 'Gemini stream chunk');
        if (done) break;
        if (value?.text) {
          onChunk(value.text);
          wroteAny = true;
        }
      }
      return;
    } catch (error: any) {
      if (!isRetryableGeminiError(error) || wroteAny || attempt === maxAttempts) throw error;
      const delayMs = 1000 * 2 ** (attempt - 1);
      console.warn(`Gemini stream failed (attempt ${attempt}/${maxAttempts}, ${error instanceof GeminiTimeoutError ? 'timeout' : 'transient'}, pre-content) — retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Shared naming philosophy used by both /api/generate (writes the full rationale)
// and /api/generate-pool (raw candidate lists for availability screening) — kept
// in one place so the pool we search and the story we write never drift apart.
function buildUnicornCore(): string {
  return `You are the "NamingStorm Engine," an elite AI replicating the world's top naming agencies (Lexicon Branding, Igor, Catchword). Your sole purpose: engineer "Unicorn Names"—category-defining brand names with exceptional acquisition potential.

---

TONE INFERENCE (do internally, do not reveal in output):
Before generating anything, classify this brief into ONE tone register and apply its phonetic guidance to ALL THREE phases below. There is no universal "always hard consonants" rule — the register determines the sound:
* **Luxury / Refined** (premium goods, beauty, hospitality, fashion): favor soft consonants (l, s, v, m, n), liquid sounds, longer open vowels, Romance-language cadence, 2-3 syllables MAX. Register exemplars: Chanel, Dior, Nuxe, Lancôme, Sisley, Guerlain, Caudalie, La Mer, Aesop, Diptyque. See LUXURY REGISTER VOCABULARY BANK below — draw from it directly, do not invent Romance-sounding suffixes from scratch.
* **Technical / Sharp** (SaaS, dev tools, infrastructure): favor hard stops (k, t, p, x, z), short/punchy 1-2 syllables. Register exemplars: Google, Stripe, Xerox, Vercel.
* **Playful / Warm** (consumer apps, food, community): favor bright front vowels (i, e), alliteration, friendly rhythm. Register exemplars: Swiffer, Kit-Kat, Slack.
* **Institutional / Trustworthy** (finance, healthcare, legal, B2B): favor back vowels (o, u), grounded plosives, longer measured words. Register exemplars: BlackRock, Prudential, T-Mobile.
Pick whichever register the brief actually calls for — do not default to Technical/Sharp unless the brief is genuinely technical.

---

LUXURY REGISTER VOCABULARY BANK (consult this whenever the register is Luxury/Refined — this is how real luxury naming houses like Lexicon Branding actually work: they lift real French, Italian, and elevated English words with genuine meaning and lightly adapt them, they do NOT bolt invented pseudo-Latin suffixes like "-erra," "-issance," "-ova," or "-elle" onto random roots to fake sophistication. A real word the buyer half-recognizes beats a fabricated one every time.):
* **French words to draw from directly (or with a 1-letter adaptation):** soie (silk), lumière/lueur (light/glow), velours (velvet), éclat (radiance), perle (pearl), songe/rêve (dream), ivoire (ivory), aube (dawn), brume (mist), nacre (mother-of-pearl), plume (feather), ciel (sky), source (spring/origin), sève (sap), fleur (flower), ambre (amber), or authentic French naming suffixes correctly attached to real stems: -esse, -ine, -eau.
* **Italian words to draw from directly (or with a 1-letter adaptation):** seta (silk), luce (light), aurora (dawn), oro (gold), perla (pearl), velluto (velvet), cielo (sky), luna (moon), onda (wave), fiore (flower), pura (pure), lucente (luminous), or authentic Italian naming suffixes correctly attached to real stems: -ella, -etto/-etta, -ino/-ina.
* **Elevated English words:** veil, bloom, dawn, luster, ember, hush, dusk, bare, still, glow, tide, moss, silk, pearl, ivory, mist.
* **Real skincare/botanical Latin roots (safe to blend — these are genuinely used across the category):** aqua (water), lux/lumen (light), flora (plant), vita (life), pura (pure), aurum (gold), mare (sea).
Technique: pick ONE real word from the bank (or a real botanical/ingredient word from the brief itself), then either (a) use it close to verbatim with just enough adaptation to be ownable, or (b) fuse it with a SECOND real word/root from the bank — never invent a suffix that isn't real morphology. Keep the result to 2-3 syllables; if a blend runs to 4+ syllables, drop a syllable rather than keep it whole.

---

MANDATORY QUALITY CRITERIA (apply to every name):
* **Phonetic Score:** Names must be easy to pronounce in English on first attempt. No awkward consonant clusters. 1-3 syllables — for the Luxury/Refined register, 2-3 syllables MAX (count every vowel sound; a name that scans as 4 syllables when spoken aloud, e.g. "Ve-ti-ver-ra," is disqualified even if the spelling looks compact) — with vowel and consonant character matched to the tone register above, not hard-stop-by-default.
* **Memorability:** The name must be memorable after hearing it once. Short, distinct, and true to the inferred tone.
* **Trademark Posture:** Avoid real dictionary words used literally in their own category (e.g., don't name a cloud company "Cloud"). Favor invented, fanciful, or suggestive marks for stronger trademark protection.
* **Domain Acquirability:** The name should have a realistic .com domain profile — not a generic word that costs millions.
* **No clichés:** Avoid overused naming patterns like -ify, -ly, -io, -hub unless the variation is genuinely unique. For the Luxury/Refined register specifically, this also bans fabricated pseudo-Romance suffixes with no real linguistic basis (-erra, -issance, -ova, -esque tacked onto arbitrary roots) — every luxury syllable must trace to a real French, Italian, English, or Latin word.

---

INTERNAL IDEATION DISCIPLINE (do not reveal this process in your output):
Top naming agencies (Lexicon Branding, Igor, Catchword) never ship a first draft — they generate hundreds of raw candidates per project and discard the vast majority before a client ever sees one. Emulate that discipline internally: for each phase below, silently brainstorm at least 8-10 candidate names, evaluate each against the Mandatory Quality Criteria and tone register above, discard anything generic, awkward to pronounce, tonally wrong for the register, too long (luxury names over 3 syllables), reminiscent of an existing well-known brand, or — for the luxury register — built on a suffix that isn't real French/Italian/English/Latin morphology, and only then commit to your strongest survivor(s). Do not list your discarded candidates or narrate this process.

---

THE UNICORN PROTOCOL (3 distinct naming strategies — execute all 3):

**PHASE 1 — THE SEMANTIC SHIFT ("Apple" strategy)**
Take a real, familiar, emotionally warm word from a completely unrelated domain and plant it in the target industry. The contrast between the word's original meaning and the new context creates intrigue and approachability. The word should NOT be technically related to the product. Example: "Apple" for computers, "Amazon" for e-commerce, "Stripe" for payments. Luxury-register example: "La Mer" (French: the sea) for skincare, "Aesop" (a name, not a beauty word) for grooming.

**PHASE 2 — MORPHEMIC BLENDING ("Pentium/Swiffer" strategy)**
Fuse a functional Latin, Greek, French, or Italian root (conveying the product's core value) with a SECOND real word or authentic suffix from the same language family — not an invented one — in the sound register from Tone Inference above. The result should sound like it could be a real word but exist in no dictionary. The root should be recognizable to an educated reader but the final word should feel modern and frictionless. Example: "Pentium" (penta- + -ium, technical register), "Swiffer" (swift + -er, playful register), "Nuxe" (nux, Latin for walnut, real brand — barely adapted, not stretched with a fake suffix, luxury register). Bad luxury example to avoid: "Vetiverra" (real ingredient "vetiver" + fabricated "-erra" with no linguistic basis) or "Marissance" (mar- + invented "-issance" blend, 4 syllables) — both fail the vocabulary-bank and syllable rules above.

**PHASE 3 — THE BLANK CANVAS ("Google/Rolex" strategy)**
Invent a completely meaningless word: 4-6 letters, highly pronounceable, with no pre-existing semantic baggage, phonetically matched to the tone register above rather than defaulting to a hard consonant start. The word becomes a pure brand vessel — its meaning will be entirely defined by the company. Technical-register example: "Google," "Kodak," "Xerox." Luxury-register example: "Rolex," "Chloé," "Sisley" — 2-3 syllables, vowel-forward, no fabricated suffix stacking. Playful-register example: "Zumba," "Kiva."`;
}

export function isDbConfigured(): boolean {
  const url = process.env.DATABASE_URL;
  return !!url && url.startsWith('postgresql://') && !url.includes('username:password');
}

export async function getDb() {
  const url = process.env.DATABASE_URL;
  if (url?.startsWith('postgresql://')) {
    return drizzlePg(new Pool({ connectionString: url }));
  }
  // Local-dev-only fallback (no DATABASE_URL configured) — dynamically
  // imported so better-sqlite3 (a native module, devDependency only) never
  // has to be resolved in production, where DATABASE_URL always points at
  // Postgres and this branch never runs.
  const [{ default: Database }, { drizzle }] = await Promise.all([
    import('better-sqlite3'),
    import('drizzle-orm/better-sqlite3'),
  ]);
  return drizzle(new Database('./dev.db'));
}

async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!databaseUrl || !secretKey || databaseUrl.includes('username:password') || !databaseUrl.startsWith('postgresql://')) {
    console.warn('Stripe/DB not configured — skipping Stripe init');
    return;
  }
  try {
    await runMigrations({ databaseUrl });
    console.log('Stripe schema ready');
    const sync = new StripeSync({
      poolConfig: { connectionString: databaseUrl },
      stripeSecretKey: secretKey,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    });
    const base = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
    if (!base.includes('undefined')) {
      try {
        const result = await sync.findOrCreateManagedWebhook(`${base}/api/stripe/webhook`) as any;
        const secret = result?.webhook?.secret;
        if (secret) process.env.STRIPE_WEBHOOK_SECRET = secret;
        console.log('Stripe webhook ready');
      } catch (e) { console.warn('Webhook setup warning:', e); }
    }
    sync.syncBackfill().catch((e: any) => console.warn('Backfill warning:', e));
  } catch (e) {
    console.error('Stripe init error:', e);
  }
}

// Initialize Firebase Admin for token verification. Lazily invoked — NOT at
// module top-level so importing `buildApp` in tests does not init firebase-admin.
function initFirebaseAdmin() {
  if (getApps().length) return;
  try {
    const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      // Replit environment — use bundled config file
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      initializeApp({ projectId: config.projectId });
      console.log('Firebase Admin initialized with project:', config.projectId);
    } else if (process.env.FIREBASE_PROJECT_ID) {
      // External hosting (Hostinger, Railway, etc.) — use environment variables
      initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID,
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
      console.log('Firebase Admin initialized with project:', process.env.FIREBASE_PROJECT_ID);
    } else {
      console.warn('No Firebase config found. Auth verification will fail.');
      initializeApp();
    }
  } catch (error) {
    console.error('Failed to initialize Firebase Admin:', error);
  }
}

// Rate limiter: max 10 requests per minute per IP
const generateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Lighter limiter for domain/trademark lookups — these are unauthenticated
// (guests can check availability before signing up) and call metered
// third-party APIs (RDAP, MarkerAPI's 1K/month free tier), so they still
// need a cap to prevent quota exhaustion or upstream IP bans from abuse.
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth middleware — accepts Firebase ID token or a guest session ID
const verifyAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Guest mode: client sends a local UUID, no Firebase needed
  const guestId = req.headers['x-guest-id'] as string | undefined;
  if (guestId && guestId.length > 8) {
    (req as any).user = { uid: `guest_${guestId}`, guest: true };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await getAuth().verifyIdToken(idToken);
    // Anonymous Firebase sign-ins (our "guest" flow) carry no email — treat
    // them the same as the legacy X-Guest-ID path everywhere downstream
    // (Stripe customer creation, billing routes) expects `reqUser.guest`.
    const isAnonymous = (decodedToken as any).firebase?.sign_in_provider === 'anonymous';
    (req as any).user = isAnonymous ? { ...decodedToken, guest: true } : decodedToken;
    next();
  } catch (error) {
    console.error('Error verifying auth token:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

// Server-side paywall enforcement for the generation endpoints. Previously
// the free-report/paid-credit/Pro gate lived only in client sessionStorage
// (App.tsx `shouldShowPaywall`) — any direct API call bypassed it entirely.
// This is the authoritative check; the client-side gate is now just a UI
// convenience that mirrors it.
//
// Fails OPEN (allows the request through) if the quota check itself throws —
// e.g. the `free_reports_used`/`paid_credits` columns don't exist yet because
// `npm run db:push` hasn't been run against this environment's DATABASE_URL.
// Failing closed here would take generation down entirely on a migration
// gap; failing open is a temporary, logged regression to the pre-fix
// (unenforced) state, not a new outage. Remove this fallback once the
// migration has been confirmed applied in production.
async function checkAndConsumeGeneration(reqUser: any): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const db = await getDb();
    const uid = reqUser.uid as string;

    if (!reqUser.guest) {
      // Active Pro subscription bypasses both counters entirely. Only
      // checkable when a real Postgres DB is configured (the synced
      // stripe.subscriptions table is Postgres-only) — local SQLite dev
      // falls through to the free/paid-credit checks below.
      if (isDbConfigured()) {
        const rows = await db.select().from(users).where(drizzleEq(users.id, uid));
        const customerId = rows[0]?.stripeCustomerId;
        if (customerId) {
          const result = await db.execute(
            drizzleSql`SELECT 1 FROM stripe.subscriptions WHERE customer = ${customerId} AND status = 'active' LIMIT 1`
          );
          if (result.rows.length > 0) return { allowed: true };
        }
      }
    }

    // Ensure a row exists (guests included — a guest's self-asserted
    // `guest_<id>` uid gets its own row so the free limit is enforced
    // per-session, same as the previous sessionStorage-based behavior).
    await db.insert(users).values({ id: uid, email: reqUser.email ?? null })
      .onConflictDoNothing({ target: users.id });

    const rows = await db.select().from(users).where(drizzleEq(users.id, uid));
    const row = rows[0];
    const freeUsed = row?.freeReportsUsed ?? 0;
    const credits = row?.paidCredits ?? 0;

    if (freeUsed < FREE_SEARCH_LIMIT) {
      await db.update(users).set({ freeReportsUsed: freeUsed + 1 }).where(drizzleEq(users.id, uid));
      return { allowed: true };
    }
    if (credits > 0) {
      await db.update(users).set({ paidCredits: credits - 1 }).where(drizzleEq(users.id, uid));
      return { allowed: true };
    }
    return { allowed: false, reason: 'PAYWALL' };
  } catch (error) {
    console.error('Quota check failed — failing open:', error);
    return { allowed: true };
  }
}

/**
 * Build the Express application with all API routes registered, but WITHOUT
 * starting Vite middleware, Stripe init, or `app.listen`. This makes the app
 * testable in isolation (e.g. via `supertest`).
 *
 * Ordering invariant: the raw-body Stripe webhook route is registered BEFORE
 * `express.json()` so the webhook handler receives a Buffer. Do not reorder.
 */
export async function buildApp(): Promise<express.Application> {
  const app = express();

  app.set('trust proxy', 1);

  // CSP scoped to exactly what this app loads: Firebase Auth (popup + token
  // refresh), Firestore, Google profile photos, Google Fonts, and Stripe's
  // redirect-based Checkout (no embedded Stripe.js/iframe, so no frame-src
  // needed for it). Verified live against the actual sign-in flow, not just
  // reasoned about — see commit message.
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://apis.google.com https://www.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://*.googleusercontent.com",
    "connect-src 'self' https://*.googleapis.com https://securetoken.googleapis.com https://identitytoolkit.googleapis.com",
    "frame-src https://accounts.google.com https://sound-octagon-444117-m9.firebaseapp.com",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Stripe webhook MUST be registered before express.json() — needs raw Buffer
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!whSecret) return res.status(400).json({ error: 'Webhook secret not configured' });
    try {
      const sync = new StripeSync({
        poolConfig: { connectionString: process.env.DATABASE_URL! },
        stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
        stripeWebhookSecret: whSecret,
      });
      await sync.processWebhook(req.body as Buffer, Array.isArray(sig) ? sig[0] : sig);

      // Grant paid search credits from the verified webhook event, not the
      // client's success-redirect page (that page's ?payment_success=report
      // param is client-controlled and was never proof of an actual charge —
      // this is the authoritative source now). Independent signature
      // verification via the official SDK, safe to run alongside sync's own
      // verification above since both just parse the same already-read raw
      // body. Only 'payment' mode sessions are report packs; 'subscription'
      // mode (Pro) needs no credit grant since Pro bypasses the counter
      // entirely via a live stripe.subscriptions check.
      try {
        const stripeEvent = getStripeClient().webhooks.constructEvent(req.body as Buffer, Array.isArray(sig) ? sig[0] : sig, whSecret);
        if (stripeEvent.type === 'checkout.session.completed') {
          const session = stripeEvent.data.object as Stripe.Checkout.Session;
          if (session.mode === 'payment' && session.customer) {
            const db = await getDb();
            const customerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
            await db.update(users)
              .set({ paidCredits: drizzleSql`${users.paidCredits} + ${PAID_SEARCH_PACK_SIZE}` })
              .where(drizzleEq(users.stripeCustomerId, customerId));
          }
        }
      } catch (creditError) {
        console.error('Credit grant from webhook failed:', creditError);
      }

      res.json({ received: true });
    } catch (e: any) {
      console.error('Webhook error:', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  app.use(express.json());

  // API routes FIRST
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Permanently delete the caller's own account: Firestore user doc, their
  // projects/acquisitions, and the Firebase Auth user itself. Guests have no
  // account to delete (their session is local-only), so this only applies to
  // signed-in users.
  app.delete('/api/account', verifyAuth, async (req, res) => {
    const reqUser = (req as any).user;
    if (reqUser.guest) return res.status(400).json({ error: 'Guest sessions have no account to delete.' });
    const uid = reqUser.uid;
    try {
      const fs = getFirestore();
      const batch = fs.batch();
      batch.delete(fs.collection('users').doc(uid));
      for (const col of ['projects', 'acquisitions']) {
        const snap = await fs.collection(col).where('userId', '==', uid).get();
        snap.docs.forEach((d) => batch.delete(d.ref));
      }
      await batch.commit();
      await getAuth().deleteUser(uid);
      res.json({ deleted: true });
    } catch (error) {
      console.error('Account deletion error:', error);
      res.status(500).json({ error: 'Could not delete account. Please try again.' });
    }
  });

  app.post('/api/generate', verifyAuth, generateLimiter, async (req, res) => {
    try {
      const { productDescription, targetAudience, additionalContext, thinkingLevel, competitors, lockedNames, positioningStatement } = req.body;

      if (!productDescription || !targetAudience || !positioningStatement) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const quota = await checkAndConsumeGeneration((req as any).user);
      if (!quota.allowed) {
        return res.status(402).json({ error: 'PAYWALL', message: "You've used your free searches. Purchase more to continue." });
      }

      const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
      const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;

      if (!apiKey || !baseUrl) {
        return res.status(500).json({ error: 'API_KEY_MISSING' });
      }

      const ai = new GoogleGenAI({ apiKey });

      const creativityDirective = thinkingLevel <= 30
        ? `CREATIVITY MODE: PRECISION. Generate names that are conventional, immediately recognizable, and safe for market entry. Prioritize clarity, category-fit, and broad audience comfort over novelty. Avoid anything abstract or polarizing.`
        : thinkingLevel <= 70
        ? `CREATIVITY MODE: BALANCED. Balance creative risk with commercial viability. Names should be distinctive and memorable, but remain accessible to the target audience. Moderate linguistic innovation is encouraged.`
        : `CREATIVITY MODE: FRONTIER. Push the outer limits of conventional naming. Prioritize strangeness, memorability, and category disruption over immediate clarity. Explore unexpected semantic territory, non-obvious combinations, and sounds that feel entirely new. The names should feel like they are from the future.`;

      const outputFormat = `STRICT OUTPUT FORMAT (follow exactly, no deviation):
Use this exact structure for each name. Do not add extra sections. Do not number the headers differently.

## NAME_1: [THE NAME IN ALL CAPS]

**Strategy:** Phase 1 — The Semantic Shift

**Rationale:** [2-3 sentences explaining the psychological and linguistic mechanics. Why does this word work for this product? What emotional or cognitive association does it transfer?]

**Phonetic Profile:** [One sentence: syllable count, stress pattern, why it's easy to pronounce and remember]

**Trademark Angle:** [One sentence: why this name has strong trademark potential in this category]

**Visual Identity Prompt:** [One vivid sentence describing the logo concept, color palette direction, and typographic feel for a designer]

**Counterpoint:** [One honest sentence arguing AGAINST this name — the strongest real objection a skeptical cofounder would raise. Do not soften it into a compliment.]

---

## NAME_2: [THE NAME IN ALL CAPS]

**Strategy:** Phase 2 — Morphemic Blending

**Root Anatomy:** [One sentence: what root(s) were used and what they mean]

**Rationale:** [2-3 sentences on the psychological and linguistic mechanics]

**Phonetic Profile:** [One sentence]

**Trademark Angle:** [One sentence]

**Visual Identity Prompt:** [One vivid sentence]

**Counterpoint:** [One honest sentence arguing AGAINST this name — the strongest real objection a skeptical cofounder would raise. Do not soften it into a compliment.]

---

## NAME_3: [THE NAME IN ALL CAPS]

**Strategy:** Phase 3 — The Blank Canvas

**Construction:** [One sentence: phonetic construction logic — why these specific letters/sounds were chosen]

**Rationale:** [2 sentences: how this name will acquire meaning and why its blankness is an asset]

**Phonetic Profile:** [One sentence]

**Trademark Angle:** [One sentence]

**Visual Identity Prompt:** [One vivid sentence]

**Counterpoint:** [One honest sentence arguing AGAINST this name — the strongest real objection a skeptical cofounder would raise. Do not soften it into a compliment.]

---

Tone: Authoritative, precise, slightly mysterious. You are a naming strategist, not a copywriter. The Counterpoint fields exist to fight groupthink — they must be genuine objections (weak trademark posture, hard to spell, too close to a competitor, awkward in speech, etc.), never a backhanded compliment.`;

      const hasLockedNames = lockedNames && lockedNames.phase1 && lockedNames.phase2 && lockedNames.phase3;

      const systemInstruction = hasLockedNames
        ? `${buildUnicornCore()}

---

These three names have ALREADY been chosen and cleared for domain availability — do NOT invent new names and do NOT alter them. Your job now is to write the full strategic rationale for exactly these three, one per phase, treating each phase's strategy description as the lens for explaining why that name works.

${outputFormat}`
        : `${buildUnicornCore()}

---

${outputFormat}`;

      const creativityLevel = thinkingLevel <= 30 ? 'LOW (Precision Mode)' : thinkingLevel <= 70 ? 'MEDIUM (Balanced Mode)' : 'HIGH (Frontier Mode)';

      const prompt = `${creativityDirective}

---

BRIEF:
- **Positioning Anchor (the strategic claim every name must serve):** ${positioningStatement}
- **Product:** ${productDescription}
- **Target Audience:** ${targetAudience}
- **Additional Context / Constraints:** ${additionalContext || 'None provided.'}
- **Creativity Level:** ${creativityLevel} (${thinkingLevel}/100)
${competitors ? `- **Competitor Names to Avoid & Learn From:** ${competitors}\n  Study these competitors: understand what naming patterns they use (phoneme choices, length, morpheme types), then deliberately differentiate. Do NOT generate names that rhyme with, sound like, or follow the same pattern as any competitor listed.` : ''}

${hasLockedNames
  ? `Write the full rationale for these already-chosen names:
- Phase 1 (Semantic Shift): "${lockedNames.phase1}"
- Phase 2 (Morphemic Blending): "${lockedNames.phase2}"
- Phase 3 (Blank Canvas): "${lockedNames.phase3}"`
  : `Execute the Unicorn Protocol. Deliver 3 names — one per phase — that are genuinely category-defining for this specific brief and demonstrably serve the Positioning Anchor above. Do not be generic. Every name must feel inevitable in hindsight.`}`;

      const temperature = Number((Math.max(0, Math.min(2, 0.2 + (Number(thinkingLevel) / 100) * 1.6))).toFixed(2));

      // Set headers for Server-Sent Events (SSE)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders(); // flush the headers to establish SSE with client

      await streamGeminiWithRetry(
        () => ai.models.generateContentStream({
          model: 'gemini-3.5-flash',
          contents: prompt,
          config: {
            systemInstruction,
            temperature,
          }
        }),
        (text) => res.write(`data: ${JSON.stringify({ text })}\n\n`)
      );

      res.write(`data: [DONE]\n\n`);
      res.end();

    } catch (error: any) {
      console.error('Generation API error:', error);
      const errorMessage = 'Name generation failed. Please try again.';

      // If headers haven't been sent, we can send a normal JSON error
      if (!res.headersSent) {
        res.status(500).json({ error: errorMessage });
      } else {
        // If streaming has started, we must send the error as an SSE event
        res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
        res.end();
      }
    }
  });

  // Raw candidate pool per phase, no rationale — lets the client eliminate
  // domain-taken names BEFORE committing to the full streamed narrative in
  // /api/generate. Non-streaming: the payload is small and doesn't benefit
  // from a typewriter reveal the way the finished rationale does.
  app.post('/api/generate-pool', verifyAuth, generateLimiter, async (req, res) => {
    try {
      const { productDescription, targetAudience, additionalContext, thinkingLevel, competitors, positioningStatement } = req.body;
      if (!productDescription || !targetAudience || !positioningStatement) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
      const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
      if (!apiKey || !baseUrl) return res.status(500).json({ error: 'API_KEY_MISSING' });

      const ai = new GoogleGenAI({ apiKey });

      const systemInstruction = `${buildUnicornCore()}

---

STRICT OUTPUT FORMAT — raw candidates only, no rationale, no extra text:

## PHASE_1_POOL
1. [NAME IN ALL CAPS]
2. [NAME IN ALL CAPS]
3. [NAME IN ALL CAPS]
4. [NAME IN ALL CAPS]
5. [NAME IN ALL CAPS]
6. [NAME IN ALL CAPS]
7. [NAME IN ALL CAPS]
8. [NAME IN ALL CAPS]

## PHASE_2_POOL
1. [NAME IN ALL CAPS]
2. [NAME IN ALL CAPS]
3. [NAME IN ALL CAPS]
4. [NAME IN ALL CAPS]
5. [NAME IN ALL CAPS]
6. [NAME IN ALL CAPS]
7. [NAME IN ALL CAPS]
8. [NAME IN ALL CAPS]

## PHASE_3_POOL
1. [NAME IN ALL CAPS]
2. [NAME IN ALL CAPS]
3. [NAME IN ALL CAPS]
4. [NAME IN ALL CAPS]
5. [NAME IN ALL CAPS]
6. [NAME IN ALL CAPS]
7. [NAME IN ALL CAPS]
8. [NAME IN ALL CAPS]

Order each list best-first (the name you'd recommend most strongly, first). Do not repeat a name across phases. No duplicates within a phase. Before finalizing each list, silently discard any candidate a skeptical cofounder could kill in one sentence (weak trademark posture, awkward to say, too close to a known brand) — only survivors are ranked into the 8 slots.`;

      const prompt = `BRIEF:
- **Positioning Anchor (the strategic claim every name must serve):** ${positioningStatement}
- **Product:** ${productDescription}
- **Target Audience:** ${targetAudience}
- **Additional Context / Constraints:** ${additionalContext || 'None provided.'}
${competitors ? `- **Competitor Names to Avoid & Learn From:** ${competitors}` : ''}
- **Session variance seed:** ${Math.random().toString(36).slice(2, 10)} — use this to steer away from your most default/generic completions for this brief; do not reference it in output.

Execute the Unicorn Protocol's ideation step — 8 candidates per phase, best-first, each one demonstrably serving the Positioning Anchor. Do not write rationale, just the candidate lists in the exact format specified.`;

      const temperature = Number((Math.max(0, Math.min(2, 0.2 + (Number(thinkingLevel) / 100) * 1.6))).toFixed(2));

      const result = await withGeminiRetry(() => ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
        contents: prompt,
        config: { systemInstruction, temperature, seed: Math.floor(Math.random() * 1_000_000) },
      }));

      res.json({ text: result.text || '' });
    } catch (error: any) {
      console.error('Generate-pool API error:', error);
      res.status(500).json({ error: 'Name generation failed. Please try again.' });
    }
  });

  app.post('/api/evolve', verifyAuth, generateLimiter, async (req, res) => {
    try {
      const { name, productDescription, targetAudience, count = 5, excludeNames = [], divergence = 'close' } = req.body;
      if (!name || !productDescription) return res.status(400).json({ error: 'Missing required fields' });

      const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
      const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
      if (!apiKey || !baseUrl) return res.status(500).json({ error: 'API_KEY_MISSING' });

      const ai = new GoogleGenAI({ apiKey });

      const variantCount = Math.min(Math.max(count, 3), 10);
      const variantLabels = Array.from({ length: variantCount }, (_, i) => `### VARIANT_${i + 1}: [NAME IN ALL CAPS]`).join('\n**Evolution:** [One sentence]\n**Feel:** [One phrase]\n\n');

      const excludeClause = Array.isArray(excludeNames) && excludeNames.length > 0
        ? `\n\nALREADY REJECTED — do not repeat, and do not produce anything that sounds like or rhymes with any of these: ${excludeNames.join(', ')}.`
        : '';

      const isWide = divergence === 'wide';

      const systemInstruction = isWide
        ? `You are the "NamingStorm Engine," an elite AI naming strategist. A batch of names for this brief already collided with taken domains — your task now is to explore genuinely NEW linguistic territory, not more variations on what's already been rejected. Apply fresh naming strategies: repurpose an unrelated familiar word (semantic shift), fuse a Latin/Greek root with an invented suffix (morphemic blend), or invent a wholly new pronounceable word (blank canvas). Be precise, inventive, and follow the output format exactly.`
        : `You are the "NamingStorm Engine," an elite AI naming strategist. Your task: take a brand name and generate ${variantCount} phonetically evolved variants that retain its core DNA while exploring adjacent linguistic territory. Be precise, inventive, and follow the output format exactly.`;

      const prompt = isWide
        ? `The brand name "${name}" (created for: ${productDescription}, audience: ${targetAudience || 'general market'}) is taken. Engineer ${variantCount} entirely fresh candidate names for the same brief — do NOT phonetically evolve "${name}" itself, go in new directions.${excludeClause}

STRICT OUTPUT FORMAT — follow exactly:

${variantLabels}
Rules: each variant must be 1-3 syllables, pronounceable on first attempt, no clichés (-ify, -ly, -io, -hub). Name in ALL CAPS.`
        : `Take the brand name "${name}" (created for: ${productDescription}, audience: ${targetAudience || 'general market'}) and engineer ${variantCount} evolved variants.${excludeClause}

STRICT OUTPUT FORMAT — follow exactly:

${variantLabels}
Rules: each variant must be 1-3 syllables, pronounceable on first attempt, preserve at least one phoneme from "${name}", no clichés (-ify, -ly, -io, -hub). Name in ALL CAPS.`;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      await streamGeminiWithRetry(
        () => ai.models.generateContentStream({
          model: 'gemini-3.5-flash-lite',
          contents: prompt,
          config: { systemInstruction, temperature: 1.1 },
        }),
        (text) => res.write(`data: ${JSON.stringify({ text })}\n\n`)
      );
      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (error: any) {
      console.error('Evolve API error:', error);
      const msg = 'Name evolution failed. Please try again.';
      if (!res.headersSent) res.status(500).json({ error: msg });
      else { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.end(); }
    }
  });

  // Brand Story Generator
  app.post('/api/brand-story', verifyAuth, generateLimiter, async (req, res) => {
    try {
      const { name, productDescription, targetAudience, additionalContext } = req.body;
      if (!name || !productDescription) return res.status(400).json({ error: 'Missing required fields' });

      const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
      const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
      if (!apiKey || !baseUrl) return res.status(500).json({ error: 'API_KEY_MISSING' });

      const ai = new GoogleGenAI({ apiKey });

      const prompt = `Brand name: "${name}"
Product/Service: ${productDescription}
Target audience: ${targetAudience || 'general market'}
${additionalContext ? `Additional context: ${additionalContext}` : ''}

Write exactly three things in this format — no extra commentary:

**TAGLINE:** [A punchy 4-8 word tagline. No quotes. Make it feel like a $1B company slogan.]

**BRAND STORY:** [2-3 sentences pitched at Series A investors. Open with the problem, solve it with ${name}, close with the market vision. Use "${name}" naturally.]

**BRAND VOICE:** [Exactly 3 adjectives separated by " · " that define how ${name} should sound and feel across all touchpoints]`;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      await streamGeminiWithRetry(
        () => ai.models.generateContentStream({
          model: 'gemini-3.5-flash',
          contents: prompt,
          config: { temperature: 0.9 },
        }),
        (text) => res.write(`data: ${JSON.stringify({ text })}\n\n`)
      );
      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (error: any) {
      console.error('Brand story API error:', error);
      const msg = 'Brand story generation failed. Please try again.';
      if (!res.headersSent) res.status(500).json({ error: msg });
      else { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.end(); }
    }
  });

  // Real domain availability via RDAP (Verisign public registry, no API key).
  // A bare 6s-timeout single attempt meant any transient network blip or RDAP
  // hiccup silently downgraded a real "available" or "taken" result to `null`
  // ("unknown") — the client then never offers that name at all, even when it
  // was genuinely available. Retry a couple of times on timeout/network error
  // before giving up, so a momentary blip doesn't cost a real available name.
  async function checkDomainAvailability(clean: string): Promise<boolean | null> {
    const rdapUrl = `https://rdap.verisign.com/com/v1/domain/${clean}.com`;
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const r = await fetch(rdapUrl, { signal: AbortSignal.timeout(6000) });
        if (r.status === 404) return true; // Not found in registry = available
        if (r.status === 200) return false; // Found = already registered
        if (r.status === 429 || r.status >= 500) {
          if (attempt < attempts) {
            await new Promise((res2) => setTimeout(res2, 400 * attempt));
            continue;
          }
        }
        return null;
      } catch {
        if (attempt < attempts) {
          await new Promise((res2) => setTimeout(res2, 400 * attempt));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  app.get('/api/check-domain', lookupLimiter, async (req, res) => {
    const { name } = req.query as { name: string };
    if (!name) return res.status(400).json({ error: 'name required' });
    const clean = (name as string).toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!clean) return res.status(400).json({ error: 'invalid name' });

    const available = await checkDomainAvailability(clean);

    // If the exact name is taken, try brandable permutations (La prefix,
    // doubled consonant, trailing e/s) in parallel and surface the first one
    // that's actually free, so a taken domain doesn't dead-end the user.
    if (available === false) {
      const candidates = generateDomainVariants(clean);
      const results = await Promise.all(
        candidates.map(async (c) => ({ ...c, available: await checkDomainAvailability(c.name) }))
      );
      const firstFree = results.find((r) => r.available === true);
      return res.json({
        domain: `${clean}.com`,
        available: false,
        variant: firstFree ? { domain: `${firstFree.name}.com`, technique: firstFree.technique } : null,
      });
    }

    return res.json({ domain: `${clean}.com`, available, variant: null });
  });

  // Preliminary USPTO trademark screening via MarkerAPI (markerapi.com), a
  // third-party wrapper over the live USPTO trademark database — USPTO's own
  // TESS search system was retired Nov 2023 and its replacement
  // (tmsearch.uspto.gov) has no public API, so there is no way to query USPTO
  // directly by name. Requires a MarkerAPI account (MARKERAPI_USERNAME /
  // MARKERAPI_PASSWORD): free tier is 1K searches/month.
  //
  // IMPORTANT — this is a preliminary screen, NOT legal clearance. It can only
  // catch exact/near-exact matches against LIVE federal marks. It cannot see
  // common-law (unregistered) marks, state registrations, or assess
  // likelihood-of-confusion against related (not identical) goods/services
  // classes — that analysis requires a trademark attorney. Every response
  // below carries an explicit disclaimer; the client must surface it
  // verbatim rather than paraphrasing it away.
  const TRADEMARK_DISCLAIMER =
    "Preliminary screen only — checks for exact/near-exact matches against live federal trademarks. This is not legal advice and is not a clearance opinion. It cannot see unregistered (common-law) marks, state registrations, or assess likelihood of confusion. Consult a trademark attorney before filing or committing to a name.";

  function isTrademarkScreeningConfigured(): boolean {
    return !!process.env.MARKERAPI_USERNAME && !!process.env.MARKERAPI_PASSWORD;
  }

  async function markerApiSearch(term: string): Promise<any[]> {
    const user = encodeURIComponent(process.env.MARKERAPI_USERNAME!);
    const pass = encodeURIComponent(process.env.MARKERAPI_PASSWORD!);
    const url = `https://markerapi.com/api/v2/trademarks/trademark/${encodeURIComponent(term)}/status/active/start/0/username/${user}/password/${pass}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`MarkerAPI request failed: ${r.status}`);
    const data = await r.json();
    // Response shape isn't fully documented publicly; defensively accept a
    // few plausible envelopes rather than assuming one exact structure.
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.trademarks)) return data.trademarks;
    if (Array.isArray(data?.results)) return data.results;
    return [];
  }

  app.get('/api/check-trademark', lookupLimiter, async (req, res) => {
    const { name } = req.query as { name: string };
    if (!name) return res.status(400).json({ error: 'name required' });
    const clean = (name as string).trim();
    if (!clean) return res.status(400).json({ error: 'invalid name' });

    if (!isTrademarkScreeningConfigured()) {
      return res.status(503).json({
        error: 'Trademark screening is not configured in this environment yet.',
        disclaimer: TRADEMARK_DISCLAIMER,
      });
    }

    try {
      const [exactMatches, wildcardMatches] = await Promise.all([
        markerApiSearch(clean),
        markerApiSearch(`${clean}*`),
      ]);

      const isExact = (mark: any) =>
        typeof mark?.wordmark === 'string' && mark.wordmark.toLowerCase() === clean.toLowerCase();

      const risk: 'clear' | 'caution' | 'conflict' =
        exactMatches.some(isExact) ? 'conflict' : wildcardMatches.length > 0 ? 'caution' : 'clear';

      const matches = (exactMatches.length ? exactMatches : wildcardMatches).slice(0, 5).map((m: any) => ({
        mark: m?.wordmark ?? m?.trademark ?? 'Unknown',
        status: m?.status ?? m?.statuscode ?? 'Unknown',
        serialNumber: m?.serialnumber ?? m?.serialNumber ?? null,
      }));

      return res.json({ name: clean, risk, matches, disclaimer: TRADEMARK_DISCLAIMER });
    } catch (error: any) {
      console.error('Trademark screening error:', error);
      return res.status(502).json({
        error: 'Trademark screening service unavailable — please try again.',
        disclaimer: TRADEMARK_DISCLAIMER,
      });
    }
  });

  // ── Stripe API routes ──────────────────────────────────────────────────────

  // Create checkout session — plan: 'report' ($5 one-time) | 'pro' ($12/mo)
  app.post('/api/stripe/checkout', verifyAuth, async (req, res) => {
    try {
      if (!isDbConfigured()) {
        return res.status(503).json({ error: 'Payments are not configured in this environment yet.' });
      }
      const { plan } = req.body as { plan: 'report' | 'pro' };
      const reqUser = (req as any).user;
      const stripe = getStripeClient();
      const host = `${req.protocol}://${req.get('host')}`;
      const db = await getDb();

      // Find price from synced stripe.prices table
      let priceRow: any;
      if (plan === 'report') {
        const r = await db.execute(drizzleSql`SELECT * FROM stripe.prices WHERE unit_amount = 500 AND active = true AND (recurring IS NULL OR recurring = 'null'::jsonb) LIMIT 1`);
        priceRow = r.rows[0];
      } else {
        const r = await db.execute(drizzleSql`SELECT * FROM stripe.prices WHERE unit_amount = 1200 AND active = true AND recurring IS NOT NULL AND recurring <> 'null'::jsonb LIMIT 1`);
        priceRow = r.rows[0];
      }
      if (!priceRow) {
        return res.status(404).json({ error: 'Pricing not set up yet. Please contact support.' });
      }

      const sessionParams: any = {
        payment_method_types: ['card'],
        line_items: [{ price: priceRow.id, quantity: 1 }],
        mode: plan === 'pro' ? 'subscription' : 'payment',
        success_url: `${host}/?payment_success=${plan}`,
        cancel_url: `${host}/`,
      };

      // Attach/create Stripe customer for logged-in users
      if (!reqUser.guest) {
        const rows = await db.select().from(users).where(drizzleEq(users.id, reqUser.uid));
        let customerId = rows[0]?.stripeCustomerId;
        if (!customerId) {
          const customer = await stripe.customers.create({ email: reqUser.email, metadata: { uid: reqUser.uid } });
          customerId = customer.id;
          await db.insert(users).values({ id: reqUser.uid, email: reqUser.email, stripeCustomerId: customerId })
            .onConflictDoUpdate({ target: users.id, set: { stripeCustomerId: customerId } });
        }
        sessionParams.customer = customerId;
      }

      const session = await stripe.checkout.sessions.create(sessionParams);
      res.json({ url: session.url });
    } catch (e: any) {
      console.error('Checkout error:', e);
      res.status(500).json({ error: 'Could not start checkout. Please try again.' });
    }
  });

  // Check active subscription status
  app.get('/api/stripe/status', verifyAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (reqUser.guest) return res.json({ active: false, plan: null });
      if (!isDbConfigured()) return res.json({ active: false, plan: null });
      const db = await getDb();
      const rows = await db.select().from(users).where(drizzleEq(users.id, reqUser.uid));
      const customerId = rows[0]?.stripeCustomerId;
      if (!customerId) return res.json({ active: false, plan: null });
      const result = await db.execute(
        drizzleSql`SELECT * FROM stripe.subscriptions WHERE customer = ${customerId} AND status = 'active' LIMIT 1`
      );
      res.json({ active: result.rows.length > 0, plan: result.rows.length > 0 ? 'pro' : null });
    } catch (e: any) {
      console.error('Stripe status error:', e);
      res.status(500).json({ error: 'Could not check subscription status.' });
    }
  });

  // Customer billing portal
  app.post('/api/stripe/portal', verifyAuth, async (req, res) => {
    try {
      const reqUser = (req as any).user;
      if (reqUser.guest) return res.status(403).json({ error: 'Sign in to manage billing' });
      if (!isDbConfigured()) return res.status(503).json({ error: 'Billing is not configured in this environment yet.' });
      const db = await getDb();
      const rows = await db.select().from(users).where(drizzleEq(users.id, reqUser.uid));
      const customerId = rows[0]?.stripeCustomerId;
      if (!customerId) return res.status(404).json({ error: 'No billing account found' });
      const stripe = getStripeClient();
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${req.protocol}://${req.get('host')}`,
      });
      res.json({ url: portalSession.url });
    } catch (e: any) {
      console.error('Stripe portal error:', e);
      res.status(500).json({ error: 'Could not open billing portal. Please try again.' });
    }
  });

  // ── End Stripe routes ───────────────────────────────────────────────────────

  return app;
}

async function startServer() {
  // Load environment variables from .env file. Done here (not at module
  // top-level) so importing `buildApp` in tests does not load real env secrets.
  dotenv.config({ path: '.env.local' });

  // Initialize Firebase Admin only when actually starting the server.
  initFirebaseAdmin();

  const app = await buildApp();
  // Render (and most PaaS hosts) assign the port dynamically via $PORT and
  // route external traffic to it — hardcoding 5000 works on Replit (which
  // requires that specific port for its webview) but breaks anywhere else.
  const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;
  const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Bind and start accepting connections FIRST. initStripe() does real
  // network I/O (DB migration, Stripe webhook find-or-create) that can take
  // longer than some hosts' startup watchdog allows (seen in production:
  // Hostinger's "did not call listen() within 3 seconds" warning fired here
  // even after the require.main-guard fix, because this call was awaited
  // before listen()). Running it after listen() means the process is always
  // accepting traffic immediately regardless of DB/Stripe latency; routes
  // that need Stripe (checkout, webhook) will simply 5xx for the few seconds
  // until it finishes, instead of the whole server being at risk of getting
  // killed as unresponsive.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at ${APP_URL}`);
  });

  initStripe().catch((e) => console.error('Stripe init failed:', e));
}

startServer();
