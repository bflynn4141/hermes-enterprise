import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import type { TenantWork } from '../../src/routes/tenant.js';

const mocks = vi.hoisted(() => ({
  getSelectedGmailThread: vi.fn(),
  loadGmailEvidenceAccount: vi.fn(),
  resolveGmailEvidenceAccessToken: vi.fn(),
}));

vi.mock('../../src/domain/agent-context-access.js', () => ({
  requireAgentContextAccess: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/inbound-email/gmail-read-api.js', () => ({
  getSelectedGmailThread: mocks.getSelectedGmailThread,
}));
vi.mock('../../src/inbound-email/gmail-read-config.js', () => ({
  gmailEvidenceFetcher: () => fetch,
}));
vi.mock('../../src/inbound-email/gmail-read-store.js', () => ({
  loadGmailEvidenceAccount: mocks.loadGmailEvidenceAccount,
  resolveGmailEvidenceAccessToken: mocks.resolveGmailEvidenceAccessToken,
}));
vi.mock('../../src/storage/sigv4.js', () => ({
  sha256Hex: vi.fn(async (value: string) => value.startsWith('{') ? 'a'.repeat(64) : 'b'.repeat(64)),
}));

import { importSelectedGmailThread } from '../../src/inbound-email/service.js';

const thread = {
  provider: 'gmail' as const,
  provider_thread_id: 'thread_1234',
  mailbox_address: 'iris@example.test',
  subject: 'Selected thread',
  messages: [{
    provider_message_id: 'message_1', internet_message_id: null, in_reply_to: null, references: [],
    sent_at: '2026-09-19T12:00:00.000Z', from: { name: 'Partner', address: 'partner@example.test' },
    to: [{ name: 'Iris', address: 'iris@example.test' }], cc: [], direction: 'inbound' as const,
    subject: 'Selected thread', snippet: 'Reply', text_body: 'Reply', content_type: 'text/plain',
    auto_submitted: null, list_unsubscribe: null, attachments: [],
  }],
};

function workWithQueries(rows: Array<unknown[]>): { work: TenantWork; queries: string[] } {
  const queries: string[] = [];
  const tx = {
    query: vi.fn(async (text: string) => {
      queries.push(text);
      return { rows: rows.shift() ?? [], rowCount: 0 };
    }),
  };
  return {
    work: {
      tx, workspaceId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222', jobs: [],
    } as unknown as TenantWork,
    queries,
  };
}

describe('selected Gmail evidence revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadGmailEvidenceAccount.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333', address: 'iris@example.test', status: 'connected',
    });
    mocks.resolveGmailEvidenceAccessToken.mockResolvedValue({ token: 'read-token' });
    mocks.getSelectedGmailThread.mockResolvedValue(thread);
  });

  it('refuses an unchanged snapshot after its Team grant is revoked', async () => {
    const { work, queries } = workWithQueries([
      [{ id: '44444444-4444-4444-8444-444444444444', name: 'Partnerships' }],
      [],
      [{
        id: '55555555-5555-4555-8555-555555555555',
        library_source_id: '66666666-6666-4666-8666-666666666666',
        library_version_id: '77777777-7777-4777-8777-777777777777',
        version: 1, title: 'Selected thread', message_count: 1,
        normalized_sha256: 'a'.repeat(64), imported_at: new Date(), team_granted: false,
      }],
    ]);
    await expect(importSelectedGmailThread(work, {} as Env, {
      agent_id: '88888888-8888-4888-8888-888888888888', thread_id: 'thread_1234',
    })).rejects.toMatchObject({ reason: 'gmail_evidence_access_revoked', status: 409 });
    expect(queries.some((query) => query.includes('INSERT INTO library_sources'))).toBe(false);
  });

  it('does not silently recreate a Team grant when revoked evidence changes', async () => {
    const { work, queries } = workWithQueries([
      [{ id: '44444444-4444-4444-8444-444444444444', name: 'Partnerships' }],
      [],
      [],
      [],
      [{ id: '66666666-6666-4666-8666-666666666666', team_granted: false }],
    ]);
    await expect(importSelectedGmailThread(work, {} as Env, {
      agent_id: '88888888-8888-4888-8888-888888888888', thread_id: 'thread_1234',
    })).rejects.toMatchObject({ reason: 'gmail_evidence_access_revoked', status: 409 });
    expect(queries.some((query) => query.includes('INSERT INTO library_source_team_grants'))).toBe(false);
    expect(queries.some((query) => query.includes('INSERT INTO library_source_versions'))).toBe(false);
  });
});
