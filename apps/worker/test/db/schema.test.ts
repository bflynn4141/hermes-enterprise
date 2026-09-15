// The SQL migrations are the source of truth; the Drizzle schema is the typed
// view of them. Two things can drift: a table or column that exists in one and
// not the other, and an enum whose values the shared contract and the CHECK
// constraint disagree about. Both are checked here, because both are the kind
// of bug that only shows up as a runtime error in production.
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_SEED,
  EVENT_KINDS,
  REQUEST_KINDS,
  REQUEST_STATUSES,
  EFFECT_KINDS,
  EFFECT_STATUSES,
  RUN_STATUSES,
} from '@hermes/shared';
import { ALL_TABLES } from '../../src/db/schema.js';
import { withClient } from './helpers.js';

async function columnsOf(table: string): Promise<Set<string>> {
  return withClient('owner', async (c) => {
    const { rows } = await c.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    return new Set(rows.map((r) => r.column_name));
  });
}

/** Read the values a text column's CHECK constraint allows. */
async function checkValues(table: string, column: string): Promise<string[]> {
  return withClient('owner', async (c) => {
    const { rows } = await c.query<{ def: string }>(
      `SELECT pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = $1 AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%' || $2 || '%'`,
      [table, column],
    );
    const def = rows.map((r) => r.def).find((d) => d.includes('ANY (ARRAY[')) ?? '';
    return [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
  });
}

describe('schema drift', () => {
  it('has every table the Drizzle schema declares', async () => {
    const declared = Object.keys(ALL_TABLES).sort();
    const live = await withClient('owner', async (c) => {
      const { rows } = await c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      return rows.map((r) => r.table_name).sort();
    });
    expect(live).toEqual(declared);
  });

  it('has every column the Drizzle schema declares, under the same name', async () => {
    const problems: string[] = [];
    for (const table of Object.values(ALL_TABLES)) {
      const name = getTableName(table);
      const live = await columnsOf(name);
      for (const column of Object.values(getTableColumns(table))) {
        if (!live.has(column.name)) problems.push(`${name}.${column.name} is missing from the database`);
      }
      const declared = new Set(Object.values(getTableColumns(table)).map((c) => c.name));
      for (const column of live) {
        if (!declared.has(column)) problems.push(`${name}.${column} exists in the database but not in the schema`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('enum parity between the shared contract and the database', () => {
  it('agrees about request kinds and statuses', async () => {
    expect((await checkValues('requests', 'kind')).sort()).toEqual([...REQUEST_KINDS].sort());
    expect((await checkValues('requests', 'status')).sort()).toEqual([...REQUEST_STATUSES].sort());
  });

  it('agrees about effect kinds and statuses', async () => {
    expect((await checkValues('effects', 'kind')).sort()).toEqual([...EFFECT_KINDS].sort());
    expect((await checkValues('effects', 'status')).sort()).toEqual([...EFFECT_STATUSES].sort());
  });

  it('agrees about run statuses', async () => {
    expect((await checkValues('runs', 'status')).sort()).toEqual([...RUN_STATUSES].sort());
  });

  it('agrees about audit event kinds', async () => {
    expect((await checkValues('events', 'kind')).sort()).toEqual([...EVENT_KINDS].sort());
  });
});

describe('the catalog seed', () => {
  it('matches the shared constant, row for row', async () => {
    const live = await withClient('owner', async (c) => {
      const { rows } = await c.query<{
        model_id: string;
        provider: string;
        transport: string;
        disabled_reason: string | null;
      }>('SELECT model_id, provider, transport, disabled_reason FROM catalog ORDER BY model_id');
      return rows;
    });
    const expected = [...CATALOG_SEED]
      .map((r) => ({
        model_id: r.model_id,
        provider: r.provider,
        transport: r.transport,
        disabled_reason: r.disabled_reason,
      }))
      .sort((a, b) => a.model_id.localeCompare(b.model_id));
    expect(live).toEqual(expected);
  });
});

describe('migrations', () => {
  it('records every file it applied, with the hash it applied', async () => {
    const { rowCount, rows } = await withClient('owner', (c) =>
      c.query<{ filename: string; sha256: string }>('SELECT filename, sha256 FROM schema_migrations ORDER BY filename'),
    );
    expect(rowCount).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      expect(row.filename).toMatch(/^\d{4}_[a-z_]+\.sql$/);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('keeps one active run per session, by index rather than by convention', async () => {
    const live = await withClient('owner', (c) =>
      c.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'runs_one_active_per_session'`,
      ),
    );
    expect(live.rows[0]?.indexdef).toContain('WHERE');
    expect(live.rows[0]?.indexdef).toContain('working');
    expect(live.rows[0]?.indexdef).toContain('waiting');
  });
});
