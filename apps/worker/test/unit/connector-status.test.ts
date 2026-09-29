import { describe, expect, it } from 'vitest';
import { CONNECTORS, CONNECTOR_KEYS } from '@hermes/shared';
import { STUCK_QUEUE_MINUTES, sendingAccountState } from '../../src/connectors/status.js';

const quiet = { held: 0, ambiguous: 0, stuck: 0 };

describe('connector catalog', () => {
  it('describes every connection once, in the order the list shows them', () => {
    expect(CONNECTORS.map((connector) => connector.key)).toEqual([...CONNECTOR_KEYS]);
  });

  it('says in words who lets each write happen', () => {
    for (const connector of CONNECTORS) {
      for (const operation of connector.operations) {
        expect(operation.plain.length).toBeGreaterThan(20);
        if (operation.gate === 'approval_policy') expect(operation.kind).toBe('write');
      }
    }
  });

  it('marks every email sender as settled by a person, and only them', () => {
    const settled = CONNECTORS.filter((connector) => connector.settle === 'person').map((connector) => connector.key);
    expect(settled).toEqual(['gmail_sending', 'microsoft_sending', 'agent_address']);
  });
});

describe('a sending account’s state', () => {
  it('is connected when the provider is happy and nothing is stuck', () => {
    expect(sendingAccountState('connected', { ...quiet, held: 2 })).toEqual({ state: 'connected', reason: null });
  });

  it('needs attention when the provider refused Hermes’s access', () => {
    expect(sendingAccountState('error', quiet)).toMatchObject({ state: 'needs_attention', reason: expect.stringMatching(/Reconnect/) });
  });

  it('needs attention while an approved email may or may not have gone out', () => {
    expect(sendingAccountState('connected', { held: 1, ambiguous: 1, stuck: 0 }))
      .toEqual({ state: 'needs_attention', reason: '1 approved email may or may not have gone out. A reviewer needs to check the mailbox.' });
  });

  it('needs attention when the queue stops moving, before the provider says anything', () => {
    expect(sendingAccountState('connected', { held: 3, ambiguous: 0, stuck: 3 }))
      .toEqual({ state: 'needs_attention', reason: `3 approved emails have waited over ${STUCK_QUEUE_MINUTES} minutes to send.` });
  });
});
