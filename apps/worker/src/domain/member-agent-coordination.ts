import type { Tx } from '../db/client.js';
import { publishEvents } from '../jobs.js';
import { proposeApproval } from './approvals.js';

const JOIN_AGENT_INSTRUCTIONS = `Help your human get oriented in this workspace and prepare bounded proposals for review. Do not contact teammates or their agents. Do not start shared work, disclose information, or make commitments without the responsible humans' approval.`;

interface JoinCoordinationInput {
  readonly tx: Tx;
  readonly workspaceId: string;
  readonly joiningUserId: string;
  readonly joiningMemberId: string;
  readonly invitationId: string;
  readonly invitedByUserId: string | null;
  readonly jobs: string[];
}

export interface JoinCoordinationResult {
  readonly agentId: string;
  readonly coordinationRequestId: string | null;
}

async function provisionJoiningAgent(input: JoinCoordinationInput): Promise<{ agentId: string; joiningName: string }> {
  const person = await input.tx.query<{ name: string | null; email: string }>(
    `SELECT name, email FROM users WHERE id = $1`,
    [input.joiningUserId],
  );
  const joiningName = person.rows[0]?.name?.trim() || person.rows[0]?.email || 'A new teammate';
  const owned = await input.tx.query<{ agent_id: string }>(
    `SELECT ao.agent_id
       FROM agent_owners ao JOIN agents a ON a.id = ao.agent_id
      WHERE ao.workspace_id = $1 AND ao.member_id = $2
      ORDER BY a.created_at LIMIT 1`,
    [input.workspaceId, input.joiningMemberId],
  );
  let agentId = owned.rows[0]?.agent_id ?? null;
  if (!agentId) {
    const created = await input.tx.query<{ id: string }>(
      `INSERT INTO agents (workspace_id, name, responsibility, instructions_active, status)
       VALUES ($1, 'Iris', 'Help this member work safely with their new team.', $2, 'draft')
       RETURNING id`,
      [input.workspaceId, JOIN_AGENT_INSTRUCTIONS],
    );
    agentId = created.rows[0]?.id ?? null;
    if (!agentId) throw new Error('the joining member agent was not created');
    await input.tx.query(
      `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1, $2, $3)`,
      [input.workspaceId, agentId, input.joiningMemberId],
    );
    await input.tx.query(
      `INSERT INTO instruction_versions
         (workspace_id, agent_id, body, status, proposed_by, sources, saved_at)
       VALUES ($1, $2, $3, 'saved', $4, '[]'::jsonb, now())`,
      [input.workspaceId, agentId, JOIN_AGENT_INSTRUCTIONS, input.joiningUserId],
    );
  }

  const hasSession = await input.tx.query(
    `SELECT 1 FROM sessions WHERE workspace_id = $1 AND owner_id = $2 AND agent_id = $3 LIMIT 1`,
    [input.workspaceId, input.joiningUserId, agentId],
  );
  if (hasSession.rowCount === 0) {
    const sessionId = crypto.randomUUID();
    await input.tx.query(
      `INSERT INTO sessions
         (id, workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime, next_seq)
       SELECT $1, $2, $3, $4, 'Welcome to the workspace', 'work',
              default_model_id, default_effort, default_runtime, 1
         FROM workspace_settings WHERE workspace_id = $2`,
      [sessionId, input.workspaceId, input.joiningUserId, agentId],
    );
    await input.tx.query(
      `INSERT INTO messages (workspace_id, session_id, seq, role, kind, text, blocks, status)
       VALUES ($1, $2, 0, 'iris', 'welcome', $3, '[]'::jsonb, 'complete')`,
      [
        input.workspaceId,
        sessionId,
        `You’re in the workspace. I’m Iris, your Hermes agent. I can help you get oriented and prepare proposals, but I won’t contact teammates or their agents without human review.`,
      ],
    );
  }
  return { agentId, joiningName };
}

async function coordinator(input: JoinCoordinationInput): Promise<{
  userId: string;
  memberId: string;
  agentId: string;
  sessionId: string;
} | null> {
  const { rows } = await input.tx.query<{
    user_id: string;
    member_id: string;
    agent_id: string;
    session_id: string | null;
  }>(
    `SELECT m.user_id, m.id AS member_id, a.id AS agent_id,
            (SELECT s.id FROM sessions s
              WHERE s.workspace_id = m.workspace_id AND s.owner_id = m.user_id
                AND s.agent_id = a.id AND NOT s.archived AND NOT s.read_only
              ORDER BY s.last_activity_at DESC LIMIT 1) AS session_id
       FROM members m
       JOIN agent_owners ao ON ao.workspace_id = m.workspace_id AND ao.member_id = m.id
       JOIN agents a ON a.workspace_id = m.workspace_id AND a.id = ao.agent_id
      WHERE m.workspace_id = $1 AND m.status = 'active' AND m.user_id <> $2
        AND a.status IN ('draft', 'started')
        AND (($3::uuid IS NOT NULL AND m.user_id = $3)
          OR ($3::uuid IS NULL AND m.role = 'admin'))
      ORDER BY (m.user_id = $3) DESC, (a.status = 'started') DESC, m.joined_at, a.created_at
      LIMIT 1`,
    [input.workspaceId, input.joiningUserId, input.invitedByUserId],
  );
  let row = rows[0];

  // Workspaces created before agent ownership was introduced can still prove
  // the same relationship through a human-owned, agent-bound session.
  if (!row && input.invitedByUserId) {
    const legacy = await input.tx.query<{
      user_id: string;
      member_id: string;
      agent_id: string;
      session_id: string;
    }>(
      `SELECT m.user_id, m.id AS member_id, a.id AS agent_id, s.id AS session_id
         FROM members m
         JOIN sessions s ON s.workspace_id = m.workspace_id AND s.owner_id = m.user_id
         JOIN agents a ON a.workspace_id = m.workspace_id AND a.id = s.agent_id
        WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.status = 'active'
          AND a.status IN ('draft', 'started') AND NOT s.archived AND NOT s.read_only
        ORDER BY (a.status = 'started') DESC, s.last_activity_at DESC LIMIT 1`,
      [input.workspaceId, input.invitedByUserId],
    );
    row = legacy.rows[0];
  }
  if (!row) return null;

  let sessionId = row.session_id;
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    await input.tx.query(
      `INSERT INTO sessions
         (id, workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime)
       SELECT $1, $2, $3, $4, 'Team coordination', 'work',
              default_model_id, default_effort, default_runtime
         FROM workspace_settings WHERE workspace_id = $2`,
      [sessionId, input.workspaceId, row.user_id, row.agent_id],
    );
  }
  return { userId: row.user_id, memberId: row.member_id, agentId: row.agent_id, sessionId };
}

async function installJoinPolicy(
  tx: Tx,
  workspaceId: string,
  requesterAgentId: string,
  requesterMemberId: string,
  receivingMemberId: string,
): Promise<string> {
  const key = `member-join-coordination-${requesterAgentId}`;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${workspaceId}:${key}`]);
  const version = await tx.query<{ version: number }>(
    `SELECT COALESCE(max(version), 0)::int + 1 AS version
       FROM approval_policies WHERE workspace_id = $1 AND key = $2`,
    [workspaceId, key],
  );
  await tx.query(
    `UPDATE approval_policies SET active = false WHERE workspace_id = $1 AND key = $2 AND active`,
    [workspaceId, key],
  );
  const steps = [
    { id: 'requester-owner', label: 'Review proposed collaboration', order: 0, reviewers: [{ kind: 'member', member_id: requesterMemberId }], quorum: 1 },
    { id: 'receiving-owner', label: 'Accept bounded collaboration', order: 1, reviewers: [{ kind: 'member', member_id: receivingMemberId }], quorum: 1 },
  ];
  await tx.query(
    `INSERT INTO approval_policies
       (workspace_id, key, version, approval_type, requester_agent_id, priority, mode,
        prevent_self_review, require_distinct_reviewers, max_duration_seconds, steps, active)
     VALUES ($1, $2, $3, 'team_commitment', $4, 1000000, 'sequential', false, true, 604800, $5::jsonb, true)`,
    [workspaceId, key, version.rows[0]?.version ?? 1, requesterAgentId, JSON.stringify(steps)],
  );
  return key;
}

async function appendCoordinationPrompt(
  input: JoinCoordinationInput,
  sessionId: string,
  requestId: string,
  joiningName: string,
): Promise<void> {
  const seq = await input.tx.query<{ seq: number }>(
    `UPDATE sessions SET next_seq = next_seq + 1, last_activity_at = now()
      WHERE id = $1 RETURNING next_seq - 1 AS seq`,
    [sessionId],
  );
  const text = `Review proposed collaboration: ${joiningName} and their Hermes agent joined. Useful first coordination points are responsibilities, one shared handoff, and the approval boundaries for future work. I have not contacted them or started either agent. Approval records this proposal only; no agent message or run is sent until a delivery executor exists.`;
  const block = {
    type: 'receipt',
    title: 'Review proposed collaboration',
    subtitle: 'No agent message or run has been sent.',
    requestId,
  };
  const inserted = await input.tx.query<{ id: string }>(
    `INSERT INTO messages (workspace_id, session_id, seq, role, kind, text, blocks, status, client_id)
     VALUES ($1, $2, $3, 'iris', 'coordination', $4, $5::jsonb, 'complete', $6)
     ON CONFLICT (session_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [input.workspaceId, sessionId, seq.rows[0]?.seq ?? 0, text, JSON.stringify([block]), `member-join:${input.invitationId}`],
  );
  const messageId = inserted.rows[0]?.id;
  if (!messageId) return;
  input.jobs.push(...await publishEvents(input.tx, input.workspaceId, [{
    kind: 'message.appended',
    sessionId,
    payload: {
      message_id: messageId,
      session_id: sessionId,
      seq: seq.rows[0]?.seq ?? 0,
      role: 'iris',
      kind: 'coordination',
      text,
      blocks: [block],
      status: 'complete',
      run_id: null,
    },
  }]));
}

/**
 * Turn the first accepted-invitation transition into owned agent state and a
 * reviewable coordination proposal. Everything here commits with acceptance;
 * it never calls a model, sends to the new member, or starts an agent run.
 */
export async function coordinateAcceptedMember(input: JoinCoordinationInput): Promise<JoinCoordinationResult> {
  const joining = await provisionJoiningAgent(input);
  const sponsor = await coordinator(input);
  let coordinationRequestId: string | null = null;

  if (sponsor) {
    const policyKey = await installJoinPolicy(
      input.tx,
      input.workspaceId,
      sponsor.agentId,
      sponsor.memberId,
      input.joiningMemberId,
    );
    const view = await proposeApproval({
      tx: input.tx,
      workspaceId: input.workspaceId,
      jobs: input.jobs,
      agentId: sponsor.agentId,
      userId: sponsor.userId,
      sessionId: sponsor.sessionId,
      sourceTrigger: {
        kind: 'member_agent_joined',
        invitation_id: input.invitationId,
        member_id: input.joiningMemberId,
        agent_id: joining.agentId,
      },
    }, {
      label: `Review proposed collaboration with ${joining.joiningName}`,
      policy_key: policyKey,
      proposal: {
        kind: 'approval',
        approval_type: 'team_commitment',
        summary: `${joining.joiningName} and their Hermes agent joined. Review a bounded first collaboration before either agent communicates or runs work.`,
        consequence: 'Approval records the proposed collaboration and advances it to the receiving owner. It does not send an agent message or start an agent run; delivery requires a separate supported executor.',
        evidence: [{
          id: `member-join-${input.invitationId}`,
          kind: 'source',
          label: 'Accepted workspace invitation',
          ref: `invitation:${input.invitationId}`,
          note: 'The member and their owned agent were created from this accepted invitation. No outreach was sent.',
        }],
        illustrative: false,
        details: {
          requester_agent_id: sponsor.agentId,
          recipient_agent_id: joining.agentId,
          receiving_owner_member_id: input.joiningMemberId,
          workload: 'Compare responsibilities and current priorities, choose one useful shared handoff, and agree which future actions require human approval.',
          due_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          dependencies: ['Both responsible humans approve this bounded proposal', 'No information is disclosed before a separately approved action'],
          acceptance_criteria: ['A responsibility map is reviewed', 'One human-owned handoff is named', 'No outbound or agent-to-agent message is sent without a supported, separately approved action'],
        },
      },
      target_agent_ids: [],
      target_member_ids: [],
      target_resource_ids: [],
      dependent_request_ids: [],
      idempotency_key: `member-join:${input.invitationId}:${sponsor.agentId}`,
    });
    coordinationRequestId = view.request_id;
    await appendCoordinationPrompt(input, sponsor.sessionId, view.request_id, joining.joiningName);
  }

  await input.tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, member_id, invitation_id)
     VALUES ($1, 'user', $2, 'member.joined', $3, $4)`,
    [input.workspaceId, input.joiningUserId, input.joiningMemberId, input.invitationId],
  );
  await input.tx.query(
    `INSERT INTO events (workspace_id, actor_type, kind, member_id, invitation_id, agent_id)
     VALUES ($1, 'system', 'agent.joined', $2, $3, $4)`,
    [input.workspaceId, input.joiningMemberId, input.invitationId, joining.agentId],
  );
  input.jobs.push(...await publishEvents(input.tx, input.workspaceId, [{
    kind: 'member.agent_joined',
    payload: {
      source: 'invitation.accepted',
      invitation_id: input.invitationId,
      member_id: input.joiningMemberId,
      agent_id: joining.agentId,
      coordination_request_id: coordinationRequestId,
    },
  }]));
  return { agentId: joining.agentId, coordinationRequestId };
}
