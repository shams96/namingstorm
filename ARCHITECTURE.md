# NamingStorm — AI Brand Naming Engine

## Overview
A full-stack web app that uses Gemini 2.5 Flash to generate elite, category-defining brand names using a structured 3-phase "Unicorn Protocol." Users fill in a product brief and receive 3 engineered brand names with phonetic profiles, trademark analysis, visual identity prompts, real domain availability checks, scoring cards, brand stories, and a full domain acquisition flow. Works for both guests and authenticated users.

## Architecture
- **Frontend:** React + Vite (TypeScript), Tailwind CSS v4, Framer Motion, react-markdown, Lucide icons
- **Backend:** Express.js server (`server.ts`) serving both the API and the Vite dev/prod bundle on port 5000
- **AI:** Google Gemini 2.5 Flash via Replit AI Integrations (`AI_INTEGRATIONS_GEMINI_API_KEY` / `AI_INTEGRATIONS_GEMINI_BASE_URL`) — no personal API key required
- **Auth:** Firebase Authentication (Google Sign-In) with Firebase Admin for server-side token verification. Guest mode available via `X-Guest-ID` header + sessionStorage UUID.
- **Database:** Firestore — stores `users`, `projects`, and `acquisitions` collections
- **Streaming:** Server-Sent Events (SSE) for all AI responses (generate, evolve, brand-story)
- **Domain Checks:** Verisign RDAP public API (no key) for real `.com` availability

## Key Files
- `server.ts` — Express server, Firebase Admin init, all API endpoints
- `src/App.tsx` — Main React component (all UI, state, and logic)
- `src/firebase.ts` — Firebase client init, auth helpers, Firestore error handler
- `src/index.css` — Global styles, Tailwind theme, `.markdown-body` styles, print CSS
- `firebase-applet-config.json` — Firebase project config (non-secret)
- `firestore.rules` — Firestore security rules
- `vite.config.ts` — Vite config with `allowedHosts: true` for canvas iframe

## API Endpoints (`server.ts`)

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/generate` | SSE — generates 3 brand names via Unicorn Protocol |
| POST | `/api/evolve` | SSE — generates 5 phonetic variants of a selected name |
| POST | `/api/brand-story` | SSE — generates tagline, investor pitch, and brand voice |
| GET | `/api/check-domain` | Real `.com` availability via Verisign RDAP (no key needed) |
| GET | `/api/health` | Health check |

All AI endpoints accept either a Firebase Bearer token (`Authorization`) or a guest ID (`X-Guest-ID` header).

## Brand Naming Logic (The Unicorn Protocol)

### 3 Phases
1. **Semantic Shift** — Familiar word from unrelated domain applied to the product (e.g., "Apple" for computers)
2. **Morphemic Blending** — Latin/Greek root fused with invented emotional suffix (e.g., "Pentium")
3. **Blank Canvas** — 4-6 letter meaningless, pronounceable invented word (e.g., "Google", "Rolex")

### Quality Criteria enforced in every generation
- Phonetic ease (1-3 syllables, hard consonants, open vowels)
- Trademark strength (fanciful/suggestive marks preferred)
- Domain acquirability (no generic words)
- No cliché suffixes (-ify, -ly, -io, -hub)

### Thinking Level Slider
- 0–30%: Precision mode — safe, conventional, broad-appeal names
- 30–70%: Balanced mode — distinctive but accessible
- 70–100%: Frontier mode — abstract, disruptive, future-facing

### Competitor Analysis
Optional input accepts comma-separated competitor names. The AI studies their phoneme patterns and naming conventions, then deliberately differentiates all generated names.

## Name Intelligence Report (per-name cards)
After generation, each name card shows:
- **Real .com availability** — live RDAP check (green = available, red = taken)
- **4 score bars** — Phonetic, Trademark, Domain, Category (deterministic scoring via `scoreNameFn`)
- **Star / Favorite** — saves to localStorage, shown in sidebar Shortlist
- **Speak** — Web Speech API pronunciation playback
- **Evolve** — streams 5 AI-generated phonetic variants
- **Story** — streams tagline + investor pitch + brand voice adjectives
- **Acquire** — selects name for domain appraisal flow

## Sidebar Features
- **Shortlisted Names** — favorites persisted in localStorage
- **Session History** — last 15 generations saved in sessionStorage (collapsible, with timestamps)
- **Secured Assets** — Firestore acquisitions (logged-in users only)
- **Project History** — past Firestore projects (logged-in users only)

## Results Panel Actions
- **Run Again** — re-fires generation with same brief
- **Share** — copies URL with brief encoded as query params (pre-fills form on open)
- **Export** — triggers print stylesheet for clean PDF export

## Industry Quick-Start Presets
8 categories with fully optimized briefs: SaaS/AI, Fintech, Health, Gaming, E-commerce, Consumer, Luxury, Legal/B2B.

## Monetization — Stripe Payments

### Pricing Model
- **5 free searches** — no login required, counted in `sessionStorage sl_free_count` (limit: `FREE_SEARCH_LIMIT` in `src/App.tsx`)
- **$5 / 10-search pack** — one-time Stripe payment (`payment` mode checkout); credits tracked in `sessionStorage sl_paid_credits`, decremented one per generation. Requires an account (guests are routed to account creation before checkout).
- **$12 / month** — recurring Stripe subscription (`subscription` mode), requires login; unlimited reports while active

### Stripe Setup
- Products live in Stripe sandbox (test keys: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`)
- Two products seeded via `npm run db:seed` (`scripts/seed-products.ts`):
  - `Single Report` — `price_1TSsw8CCGnGhmkVBn1bmeTr0` ($5 one-time)
  - `Synthetic Lexicon Pro` — `price_1TSsw9CCGnGhmkVBDX5pzr7k` ($12/month)
- Stripe schema auto-created in PostgreSQL by `stripe-replit-sync` via `runMigrations()`
- Webhook managed by `stripe-replit-sync` (auto-configured via `findOrCreateManagedWebhook`)

### Key Files
- `server/stripeClient.ts` — Stripe + StripeSync client (uses `process.env.STRIPE_SECRET_KEY` directly)
- `server/webhookHandlers.ts` — delegates to `StripeSync.processWebhook`
- `server/storage.ts` — queries `stripe.*` schema + `users` table (Drizzle ORM)
- `shared/schema.ts` — `users` table (`id`, `email`, `stripe_customer_id`, `stripe_subscription_id`)
- `drizzle.config.ts` — Drizzle Kit config for schema push
- `scripts/seed-products.ts` — creates Stripe products/prices (run once)

### Server Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/stripe/webhook` | Stripe webhook (BEFORE `express.json()`) |
| POST | `/api/stripe/checkout` | Creates checkout session (`plan`: `'report'` or `'pro'`) |
| GET | `/api/stripe/status` | Returns `{ active, plan }` for logged-in user |
| POST | `/api/stripe/portal` | Opens Stripe billing portal |

### Paywall Logic (Frontend)
- `freeReportsUsed` — `sessionStorage sl_free_count`; incremented after each successful generation, up to `FREE_SEARCH_LIMIT` (5)
- `paidCredits` — `sessionStorage sl_paid_credits`; set to `PAID_SEARCH_PACK_SIZE` (10) on `?payment_success=report` redirect; decremented one per generation
- `isPro` — checked via `/api/stripe/status` on login; set on `?payment_success=pro` redirect
- Gate in `handleGenerate`: `shouldShowPaywall({ freeReportsUsed, freeLimit, isPro, paidCredits })` → show `PaywallModal` when free searches are exhausted, not Pro, and no paid credits remain
- `handleCheckout` requires an account for both plans — guests are routed to `AccountModal` instead of Stripe
- `PaywallModal` — full-screen overlay with two pricing cards ($5 / 10 searches, $12/mo Pro); "Most Popular" badge on Pro

### DB Scripts
```bash
npm run db:push    # Push schema changes to PostgreSQL
npm run db:seed    # Create Stripe products (run once)
```

### Domain Acquisition Flow (Simulated)
After name generation, users can also:
1. Select a name from the Name Intelligence Report
2. Run a domain appraisal (simulated pricing based on name length, with TLD alternatives grid)
3. View Multi-TLD pricing (.com, .ai, .co, .io)
4. Initiate a domain + trademark acquisition (stored in Firestore `acquisitions`)
5. Pay remaining balance to mark as "secured"

Guests can view the full flow but must sign in to initiate acquisition.

## Running the App
```bash
npm run dev
```
Runs on port **5000** (required for Replit webview preview).

## Environment Variables
- `AI_INTEGRATIONS_GEMINI_API_KEY` — Auto-injected by Replit AI Integrations
- `AI_INTEGRATIONS_GEMINI_BASE_URL` — Auto-injected by Replit AI Integrations

## Guest Mode
Guests get a UUID stored in `sessionStorage` (`sl_guest_id`). This ID is sent as `X-Guest-ID` on every API request. The server's `verifyAuth` middleware checks for this header before attempting Firebase token verification, so all AI features work without login. Firestore writes (saving projects/acquisitions) require authentication.

## Persistence
- **localStorage:** `sl_favorites` — starred name shortlist (survives page refresh)
- **sessionStorage:** `sl_guest_id` — guest identity, `sl_history` — generation history
- **Firestore:** `users`, `projects`, `acquisitions` (authenticated users only)
