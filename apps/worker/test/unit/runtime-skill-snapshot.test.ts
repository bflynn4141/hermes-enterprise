import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import * as database from '../../src/db/client.js';
import type { Env } from '../../src/env.js';
import { PARTNER_PROGRAM_DEFINITION } from '../../src/enterprise-skills/registry.js';
import { loadRuntimeSkillSnapshot, runtimeSkillManifestsForAgent } from '../../src/runtime/skills.js';
import { RuntimeDb } from '../../src/runtime/store.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const agentId = '44444444-4444-4444-8444-444444444444';
const config = {
  source_purpose: 'organization_partner_research', organization_only: true, no_outreach: true,
  role_label: 'Technical partner', search_queries: ['developer agents in:name,description'],
  intake_urls: [], keywords: ['agents'],
  ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
  minimum_priority: 60, lookback_days: 180, max_candidates: 4,
  max_api_requests: 10, minimum_rate_remaining: 5,
};
const env = { PARTNER_SCREENING_CONFIG_JSON: JSON.stringify({ [agentId]: config }) } as Env;
afterEach(() => vi.restoreAllMocks());

function fixture(state: 'active' | 'paused' | 'governed' | 'legacy', fail = false) {
  let active = false;
  let inQuery = false;
  const statements: string[] = [];
  const read = (sql: string, values?: readonly unknown[]): { rows: Record<string, unknown>[] } => {
    if (sql.includes('SELECT EXISTS')) return { rows: [{ governed: state === 'governed' }] };
    if (sql.includes('FROM enterprise_skill_assignments esa')) {
      expect(values?.slice(0, 2)).toEqual([workspaceId, agentId]);
      if (values?.[2] !== PARTNER_PROGRAM_DEFINITION.key || state === 'governed' || state === 'legacy') return { rows: [] };
      return { rows: [{
        id: '55555555-5555-4555-8555-555555555555', agent_id: agentId,
        skill_key: PARTNER_PROGRAM_DEFINITION.key, skill_version: PARTNER_PROGRAM_DEFINITION.version,
        state, config, capability_grants: [], schedule: { enabled: false, interval_minutes: 360 },
        approval_policy: { human_review_required: true }, revision: 1,
        updated_at: '2026-09-19T00:00:00Z',
      }] };
    }
    return { rows: [] };
  };
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    expect(inQuery).toBe(false);
    inQuery = true;
    try {
      if (sql === 'BEGIN') { expect(active).toBe(false); active = true; }
      else expect(active).toBe(true);
      statements.push(sql);
      await Promise.resolve();
      if (sql === 'COMMIT' || sql === 'ROLLBACK') active = false;
      if (fail && sql.includes('FROM enterprise_skill_assignments esa')) throw new Error('read failed');
      return read(sql, values);
    } finally { inQuery = false; }
  });
  const end = vi.fn();
  vi.spyOn(database, 'connect').mockResolvedValue({ query, end } as unknown as Client);
  return { db: new RuntimeDb(env, workspaceId, 'test-trace'), statements, read, active: () => active };
}

describe('runtime skill snapshot transaction', () => {
  it.each(['active', 'paused', 'governed', 'legacy'] as const)('preserves %s manifests using one serial read-only transaction', async (state) => {
    const h = fixture(state);
    const expected = await runtimeSkillManifestsForAgent(env, {
      query: async <T>(sql: string, values?: readonly unknown[]) => ({ rows: h.read(sql, values).rows as T[] }),
    }, workspaceId, agentId);
    try {
      const actual = await loadRuntimeSkillSnapshot(env, h.db, workspaceId, agentId);
      expect(actual).toEqual(expected);
      expect(actual).toHaveLength(state === 'active' || state === 'legacy' ? 1 : 0);
      expect(h.statements.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
      expect(h.statements.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
      expect(h.statements.some((sql) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
      expect(h.statements.at(-1)).toBe('COMMIT');
      expect(h.active()).toBe(false);
    } finally { await h.db.close(); }
  });

  it('rolls back discovery failure and releases the transaction context for subsequent reads', async () => {
    const h = fixture('active', true);
    try {
      await expect(loadRuntimeSkillSnapshot(env, h.db, workspaceId, agentId)).rejects.toThrow('read failed');
      expect(h.statements.at(-1)).toBe('ROLLBACK');
      expect(h.statements).not.toContain('COMMIT');
      expect(h.active()).toBe(false);
      await h.db.runtimeQuery('SELECT 1');
      expect(h.statements.filter((sql) => sql === 'BEGIN')).toHaveLength(2);
      expect(h.statements.at(-1)).toBe('COMMIT');
    } finally { await h.db.close(); }
  });
});
