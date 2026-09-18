import { describe, expect, it, vi } from 'vitest';
import { callJev, JEV_MODEL_ID, normalizedTriageState, scoreTriage } from '../../src/inbox-triage/service.js';

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

  it('calls TypeSafe System One with the Jev model and bearer credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: JEV_MODEL_ID, answers: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const fetcher = fetchMock as unknown as typeof fetch;
    await expect(callJev('test-key', { request_kind: 'application' }, fetcher)).resolves.toMatchObject({
      model: JEV_MODEL_ID,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(init.body))).toMatchObject({
      state: { request_kind: 'application' },
      model: JEV_MODEL_ID,
      questions: { goal_relevance: { type: 'score' }, needs_human_triage: { type: 'noul' } },
    });
  });

  it('reports only the TypeSafe status when the API rejects a call', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('credential detail that must not be logged', { status: 401 })) as unknown as typeof fetch;
    await expect(callJev('test-key', { request_kind: 'application' }, fetcher)).rejects.toThrow('typesafe_http_401');
  });
});
