// Runs before any server test file imports. Sets dummy env so import-time
// guards (e.g. server/db.ts throwing when DATABASE_URL is unset) do not crash,
// and so routes that read process.env at request-time have sane defaults.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_dummy';
process.env.AI_INTEGRATIONS_GEMINI_API_KEY = process.env.AI_INTEGRATIONS_GEMINI_API_KEY || 'gemini-test-key';
process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || 'https://test-gemini.example';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test-project';
