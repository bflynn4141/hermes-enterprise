import { describe, expect, it } from 'vitest';
import type { Message, RequestEntity } from '@hermes/shared';
import { receiptIdsForMessage } from './Transcript.js';

const run = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const message = { run_id: run, blocks: [] } as unknown as Message;
const request = { id: requestId, run_id: run, created_at: '2026-09-15T20:00:00.000Z' } as RequestEntity;

describe('chat request receipts', () => {
  it('places a request beside the response whose run created it', () => {
    expect(receiptIdsForMessage(message, [request])).toEqual([requestId]);
  });

  it('does not repeat an explicit receipt or attach another run’s request', () => {
    const explicit = { ...message, blocks: [{ type: 'receipt', request_id: requestId }] } as Message;
    const other = { ...request, id: '33333333-3333-4333-8333-333333333333', run_id: '44444444-4444-4444-8444-444444444444' };
    expect(receiptIdsForMessage(explicit, [request, other])).toEqual([]);
  });
});
