// Row-level security, fail-closed and forced.
//
// The important test here is the third one. Hyperdrive and Neon both pool
// connections, so the connection that served a tenant transaction serves the
// next request too. If `SET LOCAL` left the setting behind, or if an unset
// setting matched everything, a request that forgot to set the tenant key would
// read another tenant's rows. The assertion is that it reads *nothing*, and
// that it does so without raising, because an error would be a signal a caller
// could catch and a silent full-table read is the failure mode that matters.
import { describe, expect, it } from 'vitest';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

describe('row-level security', () => {
  it('is enabled and forced on every tenant table', async () => {
    await withClient('owner', async (c) => {
      const { rows } = await c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace
            AND c.relkind = 'r'
            AND c.relname IN (SELECT table_name FROM hermes_tenant_tables())`,
      );
      expect(rows.length).toBeGreaterThan(25);
      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} has RLS disabled`).toBe(true);
        // Without FORCE, the owner bypasses its own policies, and migrations
        // run as the owner. This is the line that closes that hole.
        expect(row.relforcerowsecurity, `${row.relname} does not force RLS`).toBe(true);
      }
    });
  });

  it('gives every tenant table exactly one policy, spelled the same way', async () => {
    await withClient('owner', async (c) => {
      const { rows } = await c.query<{ tablename: string; policyname: string; qual: string }>(
        `SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname = 'public'`,
      );
      const byTable = new Map<string, string[]>();
      for (const row of rows) byTable.set(row.tablename, [...(byTable.get(row.tablename) ?? []), row.policyname]);
      for (const [table, policies] of byTable) {
        expect(policies, `${table} has more than one policy`).toEqual(['tenant_isolation']);
      }
      for (const row of rows) {
        const expected = row.tablename === 'workspaces' ? '(id = app_workspace_id())' : '(workspace_id = app_workspace_id())';
        expect(row.qual, `${row.tablename} policy differs`).toBe(expected);
      }
    });
  });

  it('returns zero rows and no error on a connection whose tenant key was never set', async () => {
    const fx = await seedWorkspace();

    await withClient('app', async (c) => {
      // A normal tenant transaction first, so the connection has carried a
      // tenant key at least once, exactly as a pooled connection would.
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const inside = await c.query('SELECT id FROM workspaces');
      expect(inside.rows.map((r) => r.id)).toEqual([fx.workspaceId]);
      await c.query('COMMIT');

      // Now the same connection with nothing set. This is the request that
      // forgot, or the pooled connection that was handed on.
      const bare = await c.query('SELECT id FROM workspaces');
      expect(bare.rowCount).toBe(0);

      const bareMembers = await c.query('SELECT id FROM members');
      expect(bareMembers.rowCount).toBe(0);

      // And explicitly with the empty string, which is what a previous
      // SET LOCAL can leave behind on a pooled connection.
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', '', true)`);
      const empty = await c.query('SELECT id FROM workspaces');
      expect(empty.rowCount).toBe(0);
      await c.query('COMMIT');
    });
  });

  it('never lets one workspace see another, for identical SQL', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const sql = 'SELECT id, name FROM workspaces ORDER BY id';

    const [rowsA, rowsB] = await Promise.all([
      withClient('app', async (c) => {
        await c.query('BEGIN');
        await setTenant(c, a.workspaceId, a.adminId);
        const result = await c.query(sql);
        await c.query('COMMIT');
        return result.rows;
      }),
      withClient('app', async (c) => {
        await c.query('BEGIN');
        await setTenant(c, b.workspaceId, b.adminId);
        const result = await c.query(sql);
        await c.query('COMMIT');
        return result.rows;
      }),
    ]);

    expect(rowsA.map((r) => r.id)).toEqual([a.workspaceId]);
    expect(rowsB.map((r) => r.id)).toEqual([b.workspaceId]);
  });

  it('refuses a write whose workspace_id is not the transaction tenant', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, a.workspaceId, a.adminId);
      // Writing another tenant's row fails the policy's WITH CHECK.
      await expect(
        c.query(
          `INSERT INTO requests (workspace_id, kind, label, payload) VALUES ($1, 'application', 'x', '{}'::jsonb)`,
          [b.workspaceId],
        ),
      ).rejects.toThrow(/row-level security/i);
      await c.query('ROLLBACK');
    });
  });

  it('filters the derived views by the same tenant key', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();

    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, b.workspaceId, b.adminId);
      await c.query(
        `INSERT INTO requests (workspace_id, kind, label, payload) VALUES ($1, 'application', 'Owen', '{}'::jsonb)`,
        [b.workspaceId],
      );
      await c.query('COMMIT');
    });

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, a.workspaceId, a.adminId);
      const seen = await c.query('SELECT workspace_id, pending FROM v_inbox_count');
      expect(seen.rowCount).toBe(0);
      await c.query('COMMIT');
    });

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, b.workspaceId, b.adminId);
      const seen = await c.query<{ pending: number }>('SELECT pending FROM v_inbox_count');
      expect(seen.rows[0]?.pending).toBe(1);
      await c.query('COMMIT');
    });
  });
});
