import { describe, expect, it } from 'vitest';
import { toolByName, type ToolContext } from '../../src/engine/tools.js';
import { FakeAgentDb } from './engine/fake-db.js';

const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const ARTIFACT_ID = '22222222-2222-4222-8222-222222222222';

async function context(db: FakeAgentDb, toolCallId: string): Promise<ToolContext> {
  const run = await db.loadRun();
  if (!run) throw new Error('missing run');
  return { writes: db, reads: db, run, toolCallId, now: () => new Date('2026-09-15T00:00:00Z'), mode: 'work' };
}

const payload = {
  kind: 'application',
  applicant: { name: 'Example Org', title: 'Discovered organization; did not apply' },
  proposed_role: 'Potential technical ecosystem partner',
  score: 82,
  score_max: 100,
  criteria: [{
    id: 'fit', label: 'Program fit', points: 82, points_max: 100,
    evidence: 'Iris assessment based on the stored public repository snapshot.', source_ids: [ARTIFACT_ID],
  }],
  sources: [{ id: ARTIFACT_ID, name: 'GitHub organization profile', note: 'Fetched public evidence.', url: 'https://api.github.com/orgs/ExampleOrg' }],
  missing: ['Capacity, interest and consent are unverified.'],
  discovery: {
    candidate_id: CANDIDATE_ID, source: 'github', source_key: 'ORG_node_1',
    discovered_at: '2026-09-15T00:00:00.000Z', deterministic_priority: 78,
  },
};

describe('partner candidate agent handoff', () => {
  it('lets Iris read artifacts and creates one pending request across repeated runs', async () => {
    const db = new FakeAgentDb({ agentId: 'agent-1' });
    db.partnerCandidates.push({
      id: CANDIDATE_ID, source: 'github', source_key: 'ORG_node_1', display_name: 'Example Org',
      deterministic_priority: 78,
      source_artifacts: [{ id: ARTIFACT_ID, kind: 'organization_profile', source_url: 'https://api.github.com/orgs/ExampleOrg' }],
    });
    const read = toolByName('get_partner_candidate');
    const propose = toolByName('propose_request');
    expect(read && propose).toBeTruthy();
    const evidence = await read!.run({ candidate_id: CANDIDATE_ID }, await context(db, 'read-1'));
    expect(evidence).toMatchObject({ ok: true });

    const first = await propose!.run({ kind: 'application', label: 'Potential partner · Example Org', payload }, await context(db, 'propose-1'));
    const second = await propose!.run({ kind: 'application', label: 'Potential partner · Example Org', payload }, await context(db, 'propose-2'));
    expect(first).toMatchObject({ ok: true, data: { created: true, status: 'pending' } });
    expect(second).toMatchObject({ ok: true, data: { created: false, status: 'pending' } });
    expect(db.requests).toHaveLength(1);
    expect(db.requests[0]?.subjectKey).toBe(`partner-candidate:${CANDIDATE_ID}`);
  });

  it('refuses invented source ids', async () => {
    const db = new FakeAgentDb({ agentId: 'agent-1' });
    db.partnerCandidates.push({
      id: CANDIDATE_ID, source: 'github', source_key: 'ORG_node_1', deterministic_priority: 78,
      source_artifacts: [{ id: ARTIFACT_ID }],
    });
    const propose = toolByName('propose_request')!;
    const forged = structuredClone(payload);
    forged.criteria[0]!.source_ids = ['33333333-3333-4333-8333-333333333333'];
    const outcome = await propose.run({ kind: 'application', payload: forged }, await context(db, 'forged'));
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.error).toContain('not one of the candidate source artifacts');
    expect(db.requests).toHaveLength(0);
  });
});
