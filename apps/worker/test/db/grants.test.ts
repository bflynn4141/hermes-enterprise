// The grant assertion.
//
// This is layer one of "the runtime never decides", and it is the layer that
// cannot be argued with: the `agent` role has no INSERT on decisions, and no
// amount of clever code changes that. The test reads the live grant matrix and
// compares it to the expectation written here, so a future GRANT has to be
// written in two places, one of which is this file, which a reviewer reads.
import { describe, expect, it } from 'vitest';
import { withClient } from './helpers.js';

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

async function grantsFor(role: string): Promise<Map<string, Set<Privilege>>> {
  return withClient('owner', async (c) => {
    const { rows } = await c.query<{ table_name: string; privilege_type: Privilege }>(
      `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee = $1`,
      [role],
    );
    const map = new Map<string, Set<Privilege>>();
    for (const row of rows) {
      const set = map.get(row.table_name) ?? new Set<Privilege>();
      set.add(row.privilege_type);
      map.set(row.table_name, set);
    }
    return map;
  });
}

/** What the `agent` role is allowed, table by table. Nothing else is granted. */
const AGENT_EXPECTED: Record<string, Privilege[]> = {
  workspaces: ['SELECT'],
  members: ['SELECT'],
  users: ['SELECT'],
  workspace_settings: ['SELECT'],
  agents: ['SELECT'],
  agent_capabilities: ['SELECT'],
  agent_operation_policies: ['SELECT'],
  agent_operation_approvals: ['SELECT', 'INSERT'],
  agent_files: ['SELECT'],
  agent_context_notes: ['SELECT'],
  agent_owners: ['SELECT'],
  agent_provisioning: ['SELECT'],
  agent_runtime_bindings: ['SELECT'],
  approval_resources: ['SELECT'],
  approval_policies: ['SELECT'],
  approval_requests: ['SELECT'],
  approval_revisions: ['SELECT'],
  approval_votes: ['SELECT'],
  approval_routes: ['SELECT'],
  // The agent may bind a pending continuation to its own live proposal, under
  // the trigger guard. Admission, budgets and terminal projection remain
  // app/SECURITY-DEFINER operations.
  approval_continuations: ['SELECT', 'INSERT'],
  approval_runtime_budgets: ['SELECT'],
  approval_model_reservations: ['SELECT'],
  // M3.5. The run engine may quote an uploaded document and may not mark one
  // ready, rename one or make one disappear: a tool that could mark its own
  // source ready would be a tool that could hide a failed extraction.
  attachments: ['SELECT'],
  agent_skills: ['SELECT'],
  skill_versions: ['SELECT'],
  enterprise_skill_assignments: ['SELECT'],
  enterprise_skill_assignment_revisions: ['SELECT'],
  enterprise_skill_artifacts: ['SELECT'],
  enterprise_teams: ['SELECT'],
  enterprise_team_agents: ['SELECT'],
  run_queue: ['SELECT'],
  events: ['SELECT'],
  catalog: ['SELECT'],
  workspace_provider_keys: ['SELECT'],
  effects: ['SELECT'],
  decisions: ['SELECT'],
  request_notes: ['SELECT', 'INSERT'],
  request_triage_assessments: ['SELECT'],
  requests: ['SELECT', 'INSERT'],
  documents: ['SELECT', 'INSERT'],
  run_turns: ['SELECT', 'INSERT'],
  model_calls: ['SELECT', 'INSERT'],
  // Source collection runs as the app role. The official agent can only read
  // its own persisted candidate evidence before proposing an Inbox request.
  partner_screening_runs: ['SELECT'],
  partner_source_artifacts: ['SELECT'],
  partner_candidates: ['SELECT'],
  partner_screening_run_candidates: ['SELECT'],
  partner_contact_enrichments: ['SELECT'],
  partner_engagements: ['SELECT'],
  stream_events: ['INSERT'],
  instruction_versions: ['SELECT', 'INSERT'],
  run_steps: ['SELECT', 'INSERT', 'UPDATE'],
  messages: ['SELECT', 'INSERT', 'UPDATE'],
  agent_context_fields: ['SELECT', 'INSERT', 'UPDATE'],
  runs: ['SELECT', 'UPDATE'],
  sessions: ['SELECT', 'UPDATE'],
  v_inbox_count: ['SELECT'],
  v_session_status: ['SELECT'],
};

/** The revocations the approval invariant rests on, named one by one. */
const AGENT_MUST_NOT: { table: string; privileges: Privilege[] }[] = [
  { table: 'cloud_connections', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'cloud_connection_attempts', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'run_sweep_observations', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'decisions', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'effects', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'members', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'invitations', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'jobs', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'requests', privileges: ['UPDATE', 'DELETE'] },
  { table: 'documents', privileges: ['UPDATE', 'DELETE'] },
  { table: 'stream_events', privileges: ['UPDATE', 'DELETE'] },
  { table: 'events', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'auth_sessions', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'rate_counters', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'session_shares', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'workos_sync', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'workos_events_cursor', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  // M2. A draft is a person's unsent text; the two platform tables are the only
  // cross-tenant surface in the system, and the run engine has business in
  // neither.
  { table: 'session_drafts', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'workspace_directory', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'job_ready', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  // M3.5.
  { table: 'attachments', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'agent_owners', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'agent_operation_policies', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'agent_operation_approvals', privileges: ['UPDATE', 'DELETE'] },
  { table: 'agent_operation_policy_revisions', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'enterprise_skill_assignments', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'enterprise_skill_assignment_revisions', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'enterprise_skill_artifacts', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'enterprise_teams', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'enterprise_team_agents', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  // Connector metadata is app-owned and private records are never directly
  // exposed to the agent role. The server mediates them through run grants.
  { table: 'enterprise_connection_bindings', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_records', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_handoffs', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'enterprise_run_grants', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_workflow_executions', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'request_audiences', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_workflow_settings', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_record_revisions', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_engagement_authorizations', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_invoice_intakes', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_decision_acknowledgments', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'agent_provisioning', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'agent_runtime_bindings', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'approval_resources', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'approval_policies', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'approval_requests', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'approval_revisions', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'approval_votes', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'approval_routes', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'approval_commands', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'approval_continuations', privileges: ['UPDATE', 'DELETE'] },
  { table: 'approval_runtime_budgets', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'approval_model_reservations', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_screening_runs', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_source_artifacts', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_candidates', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_screening_run_candidates', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_contact_enrichments', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_engagements', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'partner_discovery_cursors', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'outbound_email_accounts', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'outbound_email_outbox', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'contact_suppressions', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'gmail_oauth_states', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { table: 'request_triage_assessments', privileges: ['INSERT', 'UPDATE', 'DELETE'] },
];

describe('database grants', () => {
  it('keeps missing-instance observations app-owned', async () => {
    expect((await grantsFor('app')).get('run_sweep_observations')).toEqual(new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']));
    expect((await grantsFor('agent')).has('run_sweep_observations')).toBe(false);
  });

  it('gives the agent role exactly the privileges the plan lists', async () => {
    const actual = await grantsFor('agent');
    const actualPlain: Record<string, Privilege[]> = {};
    for (const [table, set] of actual) actualPlain[table] = [...set].sort();

    const expectedPlain: Record<string, Privilege[]> = {};
    for (const [table, privileges] of Object.entries(AGENT_EXPECTED)) expectedPlain[table] = [...privileges].sort();

    expect(actualPlain).toEqual(expectedPlain);
  });

  it('never grants the agent role the privileges the approval invariant forbids', async () => {
    const actual = await grantsFor('agent');
    const violations: string[] = [];
    for (const { table, privileges } of AGENT_MUST_NOT) {
      const held = actual.get(table);
      for (const privilege of privileges) {
        if (held?.has(privilege)) violations.push(`${privilege} on ${table}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the audit table and the outbox append-only for both roles', async () => {
    for (const role of ['app', 'agent']) {
      const actual = await grantsFor(role);
      expect(actual.get('events')?.has('UPDATE')).toBeFalsy();
      expect(actual.get('events')?.has('DELETE')).toBeFalsy();
      expect(actual.get('stream_events')?.has('UPDATE')).toBeFalsy();
      expect(actual.get('stream_events')?.has('DELETE')).toBeFalsy();
    }
  });

  it('never grants the app role DELETE on anything a decision depends on', async () => {
    const actual = await grantsFor('app');
    for (const table of ['decisions', 'requests', 'documents', 'effects', 'events', 'stream_events', 'runs']) {
      expect(actual.get(table)?.has('DELETE'), `app may DELETE ${table}`).toBeFalsy();
    }
    // The app records decisions; it is the only role that may.
    expect(actual.get('decisions')?.has('INSERT')).toBe(true);
  });

  it('grants PUBLIC nothing at all', async () => {
    const actual = await grantsFor('PUBLIC');
    expect([...actual.keys()]).toEqual([]);
  });

  it('gives none of the three roles a way around row-level security', async () => {
    await withClient('owner', async (c) => {
      const { rows } = await c.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
        `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('owner', 'app', 'agent')`,
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.rolbypassrls, `${row.rolname} may bypass RLS`).toBe(false);
        expect(row.rolsuper, `${row.rolname} is a superuser`).toBe(false);
      }
    });
  });
});
