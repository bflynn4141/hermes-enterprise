import { describe, expect, it } from 'vitest';
import { requestEntitySchema } from '@hermes/shared';
import { toRequestEntity, type RequestRow } from '../../src/domain/requests.js';

describe('request entity shaping', () => {
  it('bounds approval labels and summaries before validating an Inbox row', () => {
    const row: RequestRow = {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'approval',
      status: 'pending',
      label: `Draft outreach · ${'a'.repeat(240)}`,
      payload: { summary: `Evidence summary · ${'b'.repeat(240)}` },
      session_id: null,
      run_id: null,
      created_at: new Date('2026-09-17T19:51:28.209Z'),
      version: 1,
      note: null,
      decision_id: null,
      decided_at: null,
      decided_by_name: null,
    };

    const entity = requestEntitySchema.parse(toRequestEntity(row));

    expect(entity.label).toHaveLength(200);
    expect(entity.subject).toHaveLength(200);
    expect(entity.title).toHaveLength(200);
  });
});
