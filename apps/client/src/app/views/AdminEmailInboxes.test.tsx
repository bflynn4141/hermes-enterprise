import { describe, expect, it } from 'vitest';
import type { InboundEmailListItem } from '@hermes/shared';
import { mailState } from './AdminEmailInboxes.js';

describe('mailState', () => {
  it('does not infer that no reply was needed when a run saved no suggestion', () => {
    const state = mailState({ status: 'no_action', can_retry: true, problem: null, retrying: false } as InboundEmailListItem, 'Iris');
    expect(state.text).toBe('No reply suggested');
    expect(state.note).toContain('ask Iris to read it again');
    expect(state.note).toContain('Nothing will be sent without approval');
  });

  it('says a message past the daily limit is waiting for a person, not broken (C100)', () => {
    const state = mailState({ status: 'failed', can_retry: true, problem: 'daily_limit', retrying: false } as InboundEmailListItem, 'Iris');
    expect(state).toMatchObject({ text: 'Waiting for you', tone: 'quiet' });
    expect(state.note).toContain('Read it now');
  });
});
