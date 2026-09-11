import dotenv from 'dotenv';
dotenv.config();

import Stripe from 'stripe';

async function seed() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not set');

  const stripe = new Stripe(secretKey);

  console.log('Checking existing products...');

  const existing = await stripe.products.search({ query: "name:'Synthetic Lexicon Pro' AND active:'true'" });
  if (existing.data.length > 0) {
    console.log('Products already exist. Listing prices:');
    const prices = await stripe.prices.list({ product: existing.data[0].id, active: true });
    prices.data.forEach(p => console.log(`  ${p.id} — $${(p.unit_amount ?? 0) / 100} ${p.recurring ? '/ ' + p.recurring.interval : '(one-time)'}`));
    return;
  }

  console.log('Creating Single Report product ($5)...');
  const singleProduct = await stripe.products.create({
    name: 'Single Report',
    description: 'One full Synthetic Lexicon brand naming report — phonetics, trademark scoring, domain check, brand story, and PDF export.',
    metadata: { type: 'single_report' },
  });
  const singlePrice = await stripe.prices.create({
    product: singleProduct.id,
    unit_amount: 500,
    currency: 'usd',
    metadata: { type: 'single_report' },
  });
  console.log(`  Created: ${singlePrice.id} ($5 one-time)`);

  console.log('Creating Pro Monthly product ($12/mo)...');
  const proProduct = await stripe.products.create({
    name: 'Synthetic Lexicon Pro',
    description: 'Unlimited brand naming reports. Unlimited Evolve, Brand Story, domain checks, and exports.',
    metadata: { type: 'pro_monthly' },
  });
  const proPrice = await stripe.prices.create({
    product: proProduct.id,
    unit_amount: 1200,
    currency: 'usd',
    recurring: { interval: 'month' },
    metadata: { type: 'pro_monthly' },
  });
  console.log(`  Created: ${proPrice.id} ($12/mo)`);

  console.log('\nDone. Save these price IDs:');
  console.log(`  STRIPE_PRICE_REPORT=${singlePrice.id}`);
  console.log(`  STRIPE_PRICE_PRO=${proPrice.id}`);
}

seed().catch(e => { console.error(e); process.exit(1); });
