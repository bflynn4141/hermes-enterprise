import { describe, expect, it } from 'vitest';
import { normalizedTriageState, scoreTriage } from '../../src/inbox-triage/service.js';

describe('Inbox triage', () => {
  it('redacts contact details and excludes evidence bodies from model state', () => {
    const state = normalizedTriageState({
      kind: 'task', status: 'pending', label: 'Email brian@example.com at +1 (415) 555-1212',
      createdAt: new Date(),
      payload: {
        description: 'Reach brian@example.com at +1 415 555 1212; source https://example.com/private',
        sources: [{ note: 'secret evidence body' }],
      },
    });
    const encoded = JSON.stringify(state);
    expect(encoded).not.toContain('brian@example.com');
    expect(encoded).not.toContain('415');
    expect(encoded).not.toContain('secret evidence body');
    expect(encoded).not.toContain('example.com/private');
    expect(encoded).not.toContain('Reach');
    expect(state).not.toHaveProperty('label');
    expect(state).not.toHaveProperty('description');
  });

  it('keeps deterministic expiry and sensitive-authorization floors above Jev signals', () => {
    const weak = {
      goal_relevance: 0, material_impact: 0, time_sensitivity: 0,
      decision_complexity: 0, evidence_sufficiency: 3,
      primary_reason: 'routine', needs_human_triage: false,
    };
    expect(scoreTriage({ expires_in_hours: 3 }, weak).band).toBe('urgent');
    const sensitive = scoreTriage({ approval_type: 'data_disclosure' }, weak);
    expect(sensitive.score).toBeGreaterThanOrEqual(45);
    expect(sensitive.reasons).toContain('sensitive_authorization');
  });
});
