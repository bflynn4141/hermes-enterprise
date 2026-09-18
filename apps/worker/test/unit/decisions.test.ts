import { describe, expect, it, vi } from 'vitest';
import { recordDecision } from '../../src/domain/decisions.js';
import type { TenantWork } from '../../src/routes/tenant.js';

describe('legacy document decisions', () => {
  it.each(['invoice', 'agreement'] as const)('refuses an unbound %s before writing a decision', async (kind) => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 'request', kind, status: 'pending', session_id: null, label: 'Draft',
        payload: { amount_minor: 90000 }, version: 42,
      }] })
      .mockRejectedValue(new Error('attempted to write an unreviewed decision'));
    const work = { tx: { query }, session: { sid: 'session' } } as unknown as TenantWork;

    await expect(recordDecision(work, 'request', 'approve', null))
      .rejects.toMatchObject({ reason: 'review_binding_required', status: 409 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
  });

  it.each(['approval', 'task'] as const)('never permits the legacy route to decide a governed %s', async (kind) => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{
      id: 'request', kind, status: 'pending', session_id: null, label: 'Governed request', payload: {}, version: 42,
    }] });
    const work = { tx: { query } } as unknown as TenantWork;
    await expect(recordDecision(work, 'request', 'approve', null, { expected_version: 42, expected_payload_hash: 'invalid' }))
      .rejects.toMatchObject({ reason: `${kind}_route_required`, status: 409 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
