// History sentences: every audit kind reads as plain language, never as its
// enum, and every row ends in a state word a person understands.
import { describe, expect, it } from 'vitest';
import { EVENT_KINDS } from '@hermes/shared';
import { HISTORY_NEEDS_PERSON, renderHistoryRow, type HistoryRow } from '../../src/domain/history.js';

const base = (overrides: Partial<HistoryRow> = {}): HistoryRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'request.created',
  created_at: new Date('2026-09-27T10:00:00Z'),
  actor_type: 'user',
  actor_name: 'Maya Chen',
  request_id: null,
  request_kind: null,
  request_status: null,
  request_label: null,
  request_payload: null,
  decision: null,
  effect_id: null,
  effect_kind: null,
  effect_status: null,
  effect_simulation_summary: null,
  effect_role: null,
  effect_cancelled_reason: null,
  document_id: null,
  document_kind: null,
  document_version: null,
  member_name: null,
  session_id: null,
  approval_status: null,
  approval_effect_status: null,
  approval_work_status: null,
  ...overrides,
});

const TECHNICAL = /[a-z]+_[a-z]+|\b(?:uuid|oauth|api|token|runtime|workflow|hash|revision|executor|effect|quorum|tenant)\b/i;

describe('renderHistoryRow', () => {
  it('credits a suggested reply to the agent, not the member it works for', () => {
    const row = renderHistoryRow(base({
      kind: 'approval.proposed', actor_type: 'agent', actor_name: 'Maya Chen', agent_name: 'Iris',
      request_label: 'Reply to Priya Raman',
      request_payload: { approval_type: 'communication', summary: 'Thank Priya.', details: { reply_to: { inbox_id: 'x', message_id: 'y', caution: false } } },
    }));
    expect(row.text).toBe('Iris suggested a reply to Priya Raman');
  });

  it.each(EVENT_KINDS)('renders %s as a sentence with a state word', (kind) => {
    const row = renderHistoryRow(base({ kind }));
    expect(row.text).not.toContain(kind);
    expect(row.text).not.toContain('·');
    expect(row.text).not.toMatch(TECHNICAL);
    expect(row.detail).not.toMatch(TECHNICAL);
    expect(row.status).not.toBe('');
    expect(row.status).not.toBe('Working');
    expect(row.status).not.toMatch(/^[a-z]/);
  });

  it('never shows an unknown kind', () => {
    const row = renderHistoryRow(base({ kind: 'something.new_kind' }));
    expect(row.text).toBe('Maya Chen made a change');
    expect(row.status).toBe('Done');
  });

  it('names an unnamed agent only when the row names it', () => {
    expect(renderHistoryRow(base({ actor_type: 'agent', actor_name: null })).actor_name).toBe('The agent');
    expect(renderHistoryRow(base({ actor_type: 'agent', actor_name: null, agent_name: 'Iris' })).actor_name).toBe('Iris');
  });

  it('reads an email hand-off as a transfer to a team', () => {
    const row = renderHistoryRow(base({
      actor_type: 'system',
      actor_name: null,
      agent_name: 'Iris',
      handoff_role_name: 'Finance',
      request_id: '00000000-0000-4000-8000-000000000002',
      request_kind: 'task',
      request_status: 'pending',
      request_label: 'Finance: September invoice',
      request_payload: { kind: 'task', task_type: 'email_handoff' },
    }));
    expect(row.text).toBe('Iris handed “September invoice” to Finance');
    expect(row.status).toBe('Waiting');
    expect(HISTORY_NEEDS_PERSON).toContain(row.status);
  });

  it('says plainly that a practice send left nothing', () => {
    const row = renderHistoryRow(base({
      kind: 'outbound_email.simulated',
      actor_type: 'system',
      actor_name: null,
      request_kind: 'approval',
      request_label: 'Reply to Priya Raman',
    }));
    expect(row.text).toBe('Practice send: Reply to Priya Raman');
    expect(row.detail).toMatch(/nothing left Hermes/);
    expect(row.status).toBe('Not sent');
  });

  it('asks a person to check the mailbox after an interrupted send', () => {
    const row = renderHistoryRow(base({
      kind: 'outbound_email.ambiguous',
      actor_type: 'system',
      actor_name: null,
      request_kind: 'approval',
      request_label: 'Reply to Priya Raman',
    }));
    expect(row.text).toBe('Reply to Priya Raman may or may not have been sent');
    expect(row.detail).toMatch(/Check the mailbox/);
    expect(HISTORY_NEEDS_PERSON).toContain(row.status);
  });

  it('marks finished work finished and waiting work as needing a person', () => {
    const pending = renderHistoryRow(base({ request_kind: 'invoice', request_status: 'pending', request_label: 'Robin' }));
    expect(pending.status).toBe('Needs review');
    const decided = renderHistoryRow(base({ kind: 'decision.recorded', request_kind: 'invoice', request_status: 'created', request_label: 'Robin' }));
    expect(decided.status).toBe('Approved');
    const expired = renderHistoryRow(base({
      kind: 'approval.proposed',
      request_kind: 'approval',
      approval_status: 'pending',
      approval_expires_at: new Date('2020-01-01T00:00:00Z'),
      request_label: 'Share the brief',
    }));
    expect(expired.status).toBe('Expired');
  });
});
