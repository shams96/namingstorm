import { beforeEach, describe, expect, it, vi } from 'vitest';

const processWebhookSpy = vi.fn(async () => {});

vi.mock('./stripeClient', () => ({
  getStripeSync: () => ({ processWebhook: processWebhookSpy }),
}));

import { WebhookHandlers } from './webhookHandlers';

describe('WebhookHandlers', () => {
  beforeEach(() => {
    processWebhookSpy.mockClear();
  });

  it('rejects when the payload is not a Buffer', async () => {
    await expect(
      WebhookHandlers.processWebhook('not-a-buffer' as any, 'sig'),
    ).rejects.toThrow(/Payload must be a Buffer/);
    expect(processWebhookSpy).not.toHaveBeenCalled();
  });

  it('delegates the raw Buffer and signature to sync.processWebhook', async () => {
    const payload = Buffer.from('{"id":"evt_1"}');
    await WebhookHandlers.processWebhook(payload, 't=1,v1=abc');
    expect(processWebhookSpy).toHaveBeenCalledTimes(1);
    expect(processWebhookSpy).toHaveBeenCalledWith(payload, 't=1,v1=abc');
    // The buffer is passed by reference, unchanged (raw body preserved).
    expect(processWebhookSpy.mock.calls[0][0]).toBe(payload);
  });
});
