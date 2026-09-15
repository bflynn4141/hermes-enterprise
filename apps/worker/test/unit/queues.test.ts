// Which consumer gets which batch, and what the dead-letter consumers do with a
// message they cannot read.
//
// The routing matters more than it looks. One `queue()` handler serves four
// queues whose names are suffixed per environment, so a router that listed
// exact names would quietly stop handling `hermes-extract-production` the day
// production was created — and the symptom would be extractions that never
// happen, with no error anywhere.
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { handleQueue } from '../../src/queues/index.js';
import { extractMessageSchema, renderMessageSchema } from '../../src/queues/messages.js';

interface Recorded {
  acked: number;
  retried: number;
  retriedAll: boolean;
}

function batchOf(queue: string, bodies: unknown[]): { batch: MessageBatch<unknown>; recorded: Recorded } {
  const recorded: Recorded = { acked: 0, retried: 0, retriedAll: false };
  const messages = bodies.map((body, index) => ({
    id: `m${index}`,
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => {
      recorded.acked += 1;
    },
    retry: () => {
      recorded.retried += 1;
    },
  }));
  const batch = {
    queue,
    messages,
    ackAll: () => {
      recorded.acked += messages.length;
    },
    retryAll: () => {
      recorded.retriedAll = true;
    },
  } as unknown as MessageBatch<unknown>;
  return { batch, recorded };
}

// Nothing here reaches Postgres: every body is deliberately unparseable, which
// is the one path through each consumer that touches no binding.
const env = {} as Env;

describe('queue routing', () => {
  it('routes every environment s spelling of a queue to the same consumer', async () => {
    for (const queue of ['hermes-extract', 'hermes-extract-staging', 'hermes-extract-production']) {
      const { batch, recorded } = batchOf(queue, [{ nonsense: true }]);
      await handleQueue(batch, env);
      expect(recorded.retriedAll, `${queue} fell through to the default`).toBe(false);
      expect(recorded.acked).toBe(1);
    }
  });

  it('tells a queue from its dead-letter queue', async () => {
    for (const queue of ['hermes-extract-dlq', 'hermes-renders-production-dlq']) {
      const { batch, recorded } = batchOf(queue, [{ nonsense: true }]);
      await handleQueue(batch, env);
      expect(recorded.retriedAll).toBe(false);
      expect(recorded.acked).toBe(1);
    }
  });

  it('retries rather than acks a queue this build does not know about', async () => {
    // An unknown queue means a deploy is behind. Acking would delete the
    // messages it is behind on.
    const { batch, recorded } = batchOf('hermes-something-new', [{}]);
    await handleQueue(batch, env);
    expect(recorded.retriedAll).toBe(true);
    expect(recorded.acked).toBe(0);
  });

  it('acks a message it cannot parse instead of retrying it forever', async () => {
    const { batch, recorded } = batchOf('hermes-extract', [{ workspace_id: 'not-a-uuid' }]);
    await handleQueue(batch, env);
    expect(recorded.acked).toBe(1);
    expect(recorded.retried).toBe(0);
  });
});

describe('queue message contracts', () => {
  it('refuses an extract message missing anything the consumer needs', () => {
    expect(
      extractMessageSchema.safeParse({
        workspace_id: '11111111-1111-4111-8111-111111111111',
        kind: 'attachment',
        id: '22222222-2222-4222-8222-222222222222',
        storage_key: 'w/1/uploads/2',
        mime: 'application/pdf',
      }).success,
    ).toBe(true);
    expect(extractMessageSchema.safeParse({ workspace_id: 'x' }).success).toBe(false);
    // `strict()`: an extra field is a producer and consumer disagreeing about
    // the shape, which is exactly what should be loud.
    expect(
      extractMessageSchema.safeParse({
        workspace_id: '11111111-1111-4111-8111-111111111111',
        kind: 'attachment',
        id: '22222222-2222-4222-8222-222222222222',
        storage_key: 'k',
        mime: 'text/plain',
        surprise: 1,
      }).success,
    ).toBe(false);
  });

  it('keeps the renders message keyed on the pair the dedupe uses', () => {
    const parsed = renderMessageSchema.safeParse({
      workspace_id: '11111111-1111-4111-8111-111111111111',
      document_id: '22222222-2222-4222-8222-222222222222',
      version: 2,
    });
    expect(parsed.success).toBe(true);
  });
});
