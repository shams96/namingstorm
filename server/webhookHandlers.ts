import { getStripeSync } from './stripeClient.js';

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error('Payload must be a Buffer. Ensure webhook route is before express.json().');
    }
    const sync = getStripeSync();
    await sync.processWebhook(payload, signature);
  }
}
