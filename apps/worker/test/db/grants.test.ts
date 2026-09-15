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
  agent_files: ['SELECT'],
  agent_skills: ['SELECT'],
  skill_versions: ['SELECT'],
  run_queue: ['SELECT'],
  events: ['SELECT'],
  catalog: ['SELECT'],
  workspace_provider_keys: ['SELECT'],
  effects: ['SELECT'],
  decisions: ['SELECT'],
  request_notes: ['SELECT', 'INSERT'],
  requests: ['SELECT', 'INSERT'],
  documents: ['SELECT', 'INSERT'],
  run_turns: ['SELECT', 'INSERT'],
  model_calls: ['SELECT', 'INSERT'],
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
];

describe('database grants', () => {
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
