import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalEvidenceViewSchema, type ApprovalProposal, type ApprovalView } from '@hermes/shared';
import { withTenantTransaction } from '../../src/db/client.js';
import { proposeApproval } from '../../src/domain/approvals.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { INBOX_HEADERS } from './m4-fixtures.js';

const { env, hubCalls } = makeEnv();
const FETCHED = '2026-09-16T12:00:00.000Z';
const VERIFIED = '2026-09-16T12:01:00.000Z';
const DIGEST = 'a'.repeat(64);

async function evidenceFixture(extraEvidenceId?: string, hasReviewedAddress = true) {
  const fx = await seedWorkspace();
  const ids = {
    discovery: randomUUID(), newerDiscovery: randomUUID(), sourceRun: randomUUID(), otherRun: randomUUID(),
    candidate: randomUUID(), otherCandidate: randomUUID(), source: randomUUID(), contact: randomUUID(),
    unlinked: randomUUID(), wrongCandidate: randomUUID(), unsafe: randomUUID(), wrongRunContact: randomUUID(),
    wrongAgentSource: randomUUID(), wrongAgentDiscovery: randomUUID(), otherAgent: randomUUID(),
  };
  let adminMemberId = '';
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    const members = await c.query<{ id: string; user_id: string }>('SELECT id, user_id FROM members WHERE workspace_id=$1', [fx.workspaceId]);
    adminMemberId = members.rows.find((member) => member.user_id === fx.adminId)!.id;
    const reviewerMemberId = members.rows.find((member) => member.user_id === fx.memberId)!.id;
    await c.query('INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1,$2,$3)', [fx.workspaceId, fx.agentId, adminMemberId]);
    await c.query(`INSERT INTO agents (id, workspace_id, name, status) VALUES ($1,$2,'Other Iris','started')`, [ids.otherAgent, fx.workspaceId]);
    await c.query(
      `INSERT INTO approval_policies (workspace_id,key,approval_type,requester_agent_id,priority,mode,prevent_self_review,steps)
       VALUES ($1,$2,'communication',$3,100,'parallel',false,$4::jsonb)`,
      [fx.workspaceId, `partner-outreach-draft-${fx.agentId}`, fx.agentId, JSON.stringify([
        { id: 'owner', label: 'Sender review', order: 0, reviewers: [{ kind: 'member', member_id: adminMemberId }], quorum: 1 },
        { id: 'reviewer', label: 'Workspace review', order: 1, reviewers: [{ kind: 'member', member_id: reviewerMemberId }], quorum: 1 },
      ])],
    );
    for (const runId of [ids.sourceRun, ids.otherRun]) {
      await c.query(
        `INSERT INTO runs (id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,trace_id,mode)
         VALUES ($1,$2,$3,$4,$7,'deepseek-flash',$5,$6,'work')`,
        [runId, fx.workspaceId, fx.sessionId, fx.agentId, randomUUID(), randomUUID(), runId === ids.sourceRun ? 'working' : 'completed'],
      );
    }
    for (const runId of [ids.discovery, ids.newerDiscovery, ids.wrongAgentDiscovery]) {
      await c.query(
        `INSERT INTO partner_screening_runs (id,workspace_id,agent_id,created_by,idempotency_key,status,source,authentication,config_snapshot,api_requests_max)
         VALUES ($1,$2,$3,$4,$5,'completed','agentcash_people','wallet','{}',1)`,
        [runId, fx.workspaceId, runId === ids.wrongAgentDiscovery ? ids.otherAgent : fx.agentId, fx.adminId, randomUUID()],
      );
    }
    for (const candidateId of [ids.candidate, ids.otherCandidate]) {
      await c.query(
        `INSERT INTO partner_candidates (id,workspace_id,agent_id,source,source_key,display_name,profile_url,
          deterministic_priority,priority_breakdown,confidence,latest_run_id,first_seen_at,last_seen_at)
         VALUES ($1,$2,$3,'agentcash_people',$4,'Alex Researcher','https://www.linkedin.com/in/alex-researcher',
          80,'[]','high',$5,$6,$6)`,
        [candidateId, fx.workspaceId, fx.agentId, candidateId, ids.newerDiscovery, FETCHED],
      );
    }
    for (const artifactId of [ids.source, ids.unlinked, ids.wrongCandidate, ids.unsafe, ids.wrongAgentSource]) {
      await c.query(
        `INSERT INTO partner_source_artifacts (id,workspace_id,run_id,source,artifact_key,kind,source_url,source_updated_at,fetched_at,sha256,content)
         VALUES ($1,$2,$3,'agentcash_people',$4,'person_profile',$5,NULL,$6,$7,$8::jsonb)`,
        [artifactId, fx.workspaceId, artifactId === ids.wrongAgentSource ? ids.wrongAgentDiscovery : ids.discovery, artifactId,
          artifactId === ids.unsafe ? 'javascript:alert(1)' : 'https://www.linkedin.com/in/alex-researcher?tracking=removed', FETCHED, DIGEST,
          JSON.stringify({ full_name: 'Alex Researcher', headline: 'Hermes implementation consultant', skills: ['Agent workflows'],
            current_employment: { title: 'Engineer', description: 'Builds production agent workflows' },
            company: { name: 'Research Studio' }, private_data: 'must-not-project', professional_emails: ['extra@example.test'] })],
      );
    }
    for (const [runId, candidateId, artifactIds] of [
      [ids.discovery, ids.candidate, [ids.source, ids.unsafe]],
      [ids.discovery, ids.otherCandidate, [ids.wrongCandidate]],
      [ids.newerDiscovery, ids.candidate, []],
      [ids.wrongAgentDiscovery, ids.candidate, [ids.wrongAgentSource]],
    ] as const) {
      await c.query(
        `INSERT INTO partner_screening_run_candidates (workspace_id,run_id,candidate_id,deterministic_priority,priority_breakdown,confidence,artifact_ids)
         VALUES ($1,$2,$3,80,'[]','high',$4::uuid[])`, [fx.workspaceId, runId, candidateId, artifactIds],
      );
    }
    for (const [contactId, runId] of [[ids.wrongRunContact, ids.otherRun], [ids.contact, ids.sourceRun]]) {
      await c.query(
        `INSERT INTO partner_contact_enrichments (id,workspace_id,agent_id,candidate_id,run_id,runtime_run_id,status,
          contact_data,preferred_email,verification_status,verification_score,verification_checks,draft_eligible,
          verification_poll_url,fetched_at,verified_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'completed',$7::jsonb,'reviewed@example.test','valid',98,'{"smtp_check":true}',$11,
          'https://provider.example/private-job',$8,$9,$10)`,
        [contactId, fx.workspaceId, fx.agentId, ids.candidate, runId, `run_${randomUUID().replaceAll('-', '')}`,
          JSON.stringify({ professional_emails: ['reviewed@example.test', 'extra@example.test'], phones: [], social_profiles: [] }),
          FETCHED, VERIFIED, contactId === ids.contact ? VERIFIED : '2026-09-15T00:00:00.000Z', hasReviewedAddress],
      );
    }
    await c.query('COMMIT');
  });
  const proposal: ApprovalProposal = {
    kind: 'approval', approval_type: 'communication', illustrative: false,
    summary: 'Review a personalized partner outreach draft.', consequence: 'Approval records reviewed copy and sends nothing.',
    evidence: [ids.source, ids.contact, ids.unlinked, ids.wrongCandidate, ids.unsafe, ids.wrongRunContact, ids.wrongAgentSource, ...(extraEvidenceId ? [extraEvidenceId] : [])]
      .map((id) => ({ id, kind: 'artifact', label: id === ids.contact ? 'Stored email verification' : 'Stored professional profile', note: 'Iris cited this evidence.', ref: 'https://evil.example/untrusted-proposal-ref' })),
    details: {
      channel: 'email', draft_only: true, sender: { member_id: adminMemberId, address: 'sender@example.test' },
      recipients: [{ name: 'Alex Researcher', address: hasReviewedAddress ? 'reviewed@example.test' : null, candidate_id: ids.candidate, phone_numbers: [], social_profiles: [] }],
      subject: 'Explore the Hermes Partner Program', body: 'Your agent workflow experience could be relevant. Would you like to explore the program?', attachments: [],
    },
  };
  const view = await withTenantTransaction(env, 'app', { workspaceId: fx.workspaceId, userId: fx.adminId }, (tx) => proposeApproval(
    { tx, workspaceId: fx.workspaceId, jobs: [], agentId: fx.agentId, sessionId: fx.sessionId, runId: ids.sourceRun },
    { label: 'Alex partner draft', policy_key: `partner-outreach-draft-${fx.agentId}`, proposal,
      target_agent_ids: [], target_member_ids: [], target_resource_ids: [], dependent_request_ids: [], idempotency_key: `evidence:${randomUUID()}` },
  ));
  return { ...fx, ids, proposal, view };
}

type EvidenceFixture = Awaited<ReturnType<typeof evidenceFixture>>;
const path = (fx: EvidenceFixture, id: string) => `/w/${fx.workspaceId}/requests/${fx.view.request_id}/approval/evidence/${id}`;

describe('approval-scoped stored partner evidence', () => {
  let fx: EvidenceFixture;
  let foreign: EvidenceFixture;
  beforeAll(async () => {
    foreign = await evidenceFixture();
    fx = await evidenceFixture(foreign.ids.source);
  });

  it('lets a non-owner workspace reviewer read the original cited snapshot without opening the private session', async () => {
    const response = await asUser(env, fx.memberId, path(fx, fx.ids.source));
    expect(response.status).toBe(200);
    const evidence = approvalEvidenceViewSchema.parse(await response.json());
    expect(evidence).toMatchObject({ id: fx.ids.source, kind: 'partner_source', fetched_at: FETCHED,
      source_url: 'https://www.linkedin.com/in/alex-researcher', source_updated_at: null, verified_at: null, sha256: DIGEST });
    expect(evidence.facts).toContainEqual({ label: 'Current role', value: 'Engineer' });
    expect(JSON.stringify(evidence)).not.toMatch(/must-not-project|extra@example|evil\.example|runtime_run|session_id/);
    expect((await asUser(env, fx.memberId, `/w/${fx.workspaceId}/sessions/${fx.sessionId}`)).status).toBe(404);
    expect((await asUser(env, fx.memberId, `/w/${fx.workspaceId}/traces/${fx.ids.sourceRun}`)).status).toBe(404);
    // latest_run_id already points at newerDiscovery, which has no artifacts.
    // Successful resolution proves the cited artifact's historical association was used.
  });

  it('projects only the reviewed recipient and exact runtime-run verification record', async () => {
    const response = await asUser(env, fx.memberId, path(fx, fx.ids.contact));
    expect(response.status).toBe(200);
    const evidence = approvalEvidenceViewSchema.parse(await response.json());
    expect(evidence).toMatchObject({ kind: 'contact_verification', fetched_at: FETCHED, verified_at: VERIFIED, source_url: null, sha256: null });
    expect(evidence.facts).toContainEqual({ label: 'Reviewed recipient', value: 'reviewed@example.test' });
    expect(evidence.facts).toContainEqual({ label: 'Email verification', value: 'valid' });
    expect(JSON.stringify(evidence)).not.toMatch(/extra@example|private-job|verification_poll|runtime_run/);
  });

  it('does not mutate authorization, queue work or publish session events while evidence is read', async () => {
    const before = await readTenant(fx.workspaceId, fx.adminId, (c) => c.query('SELECT authorization_revision, authorization_hash FROM approval_requests WHERE request_id=$1', [fx.view.request_id]));
    const notifications = hubCalls.length;
    await asUser(env, fx.memberId, path(fx, fx.ids.source));
    const after = await readTenant(fx.workspaceId, fx.adminId, (c) => c.query('SELECT authorization_revision, authorization_hash FROM approval_requests WHERE request_id=$1', [fx.view.request_id]));
    expect(after.rows).toEqual(before.rows);
    expect(hubCalls).toHaveLength(notifications);
  });

  it('never reveals a stored preferred email when the reviewed draft has no recipient address', async () => {
    const withoutAddress = await evidenceFixture(undefined, false);
    const response = await asUser(env, withoutAddress.memberId, path(withoutAddress, withoutAddress.ids.contact));
    expect(response.status).toBe(200);
    const evidence = approvalEvidenceViewSchema.parse(await response.json());
    expect(evidence.facts).toContainEqual({ label: 'Eligible for draft', value: 'No' });
    expect(JSON.stringify(evidence)).not.toContain('@example.test');
  });

  it('refuses uncited, unlinked, wrong-candidate, wrong-agent, foreign-workspace and wrong-runtime-run records', async () => {
    for (const id of [randomUUID(), fx.ids.unlinked, fx.ids.wrongCandidate, fx.ids.wrongAgentSource, foreign.ids.source, fx.ids.wrongRunContact]) {
      const response = await asUser(env, fx.memberId, path(fx, id));
      expect(response.status, id).toBe(404);
      expect(await response.json()).toMatchObject({ reason: 'approval_evidence_unavailable' });
    }
    expect((await asUser(env, foreign.memberId, path(fx, fx.ids.source))).status).toBe(404);
    expect((await asUser(env, fx.memberId, `/w/${fx.workspaceId}/requests/${foreign.view.request_id}/approval/evidence/${foreign.ids.source}`)).status).toBe(404);
  });

  it('keeps valid stored facts reviewable when a source URL is unsafe, without using the proposal ref', async () => {
    const response = await asUser(env, fx.memberId, path(fx, fx.ids.unsafe));
    expect(response.status).toBe(200);
    const evidence = approvalEvidenceViewSchema.parse(await response.json());
    expect(evidence.source_url).toBeNull();
    expect(evidence.facts).toContainEqual({ label: 'Name', value: 'Alex Researcher' });
    expect(JSON.stringify(evidence)).not.toMatch(/javascript:|evil\.example/);
  });

  it('stops serving a citation removed by a real approval revision', async () => {
    const revised = await evidenceFixture();
    const proposal = { ...revised.proposal, evidence: revised.proposal.evidence.filter((item) => item.id !== revised.ids.source) };
    const response = await asUser(env, revised.adminId, `/w/${revised.workspaceId}/requests/${revised.view.request_id}/approval/revisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: { proposal, change_summary: 'Remove an unnecessary source.',
        expected_authorization_revision: revised.view.payload.authorization.revision,
        expected_authorization_hash: revised.view.payload.authorization.hash, idempotency_key: `revision:${randomUUID()}` },
    });
    expect(response.status).toBe(201);
    expect((await response.json() as ApprovalView).payload.authorization.revision).toBe(2);
    expect((await asUser(env, revised.memberId, path(revised, revised.ids.source))).status).toBe(404);
    expect((await asUser(env, revised.memberId, path(revised, revised.ids.contact))).status).toBe(200);
  });
});
