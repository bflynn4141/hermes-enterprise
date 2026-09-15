// `pnpm restore:check` — the post-restore reconciliation.
//
// Plan section 5: "After any restore: the documents reconciliation query;
// membership reconciliation against `listOrganizationMemberships`; a live-KEK
// check; terminate instances with no matching run row or an attempt ahead of
// the row, then run the orphan sweep; jobs replay safely by their keys."
//
// A restore is not finished when `pg_restore` exits. It is finished when the
// four things that can be *silently wrong afterwards* have been checked, and
// each one is silent for a different reason:
//
//   documents      The rows came back and the R2 objects did not, because R2
//                  and Postgres are restored from different places at different
//                  times. The symptom is a document that renders a spinner
//                  forever. The fix is to set `render_status = 'missing'` so
//                  the product says "no longer available" instead.
//
//   memberships    WorkOS kept accepting sign-ins during the outage. The
//                  restored `members` table is from before it, so somebody who
//                  was removed can sign in again and somebody who joined
//                  cannot. This is the check with a security consequence, and
//                  it is the one nothing else would ever notice.
//
//   KEK            The restored `workspace_provider_keys` rows are wrapped
//                  under whichever KEK version was current when the dump was
//                  taken. If that secret has since been rotated away, every
//                  provider key in the restored database is unreadable — and
//                  the symptom is every run failing with a decryption error
//                  hours later, not at restore time.
//
//   instances      Workflow instances outlive a database restore. An instance
//                  whose run row is gone, or whose attempt is ahead of the row,
//                  will happily keep writing to a run that no longer exists.
//
// Read-only by default. `--fix` performs exactly one repair — marking documents
// whose object is missing — because that one is unambiguous and the other three
// need a human deciding what the truth is.
//
// Usage:
//   pnpm restore:check
//   pnpm restore:check --fix
//   pnpm restore:check --workspace <uuid>
import pg from 'pg';
import { OWNER_URL } from './db-config.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
};

const FIX = flag('fix');
const ONLY_WORKSPACE = value('workspace');

const results = [];
const record = (name, ok, detail, rows = []) => {
  results.push({ name, ok, detail, rows });
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${name}: ${detail}`);
  for (const row of rows.slice(0, 20)) console.log(`       ${JSON.stringify(row)}`);
  if (rows.length > 20) console.log(`       ... and ${rows.length - 20} more`);
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER ?? OWNER_URL });
await client.connect();

// Every query below runs as `owner`, which is NOBYPASSRLS like the other two
// roles (decision 3), so each one is run inside a tenant transaction per
// workspace. The workspace list comes from `workspace_directory`, the platform
// table that exists precisely so a cross-tenant question has an answer.
const { rows: workspaces } = await client.query(
  ONLY_WORKSPACE
    ? 'SELECT workspace_id, workos_organization_id FROM workspace_directory WHERE workspace_id = $1'
    : 'SELECT workspace_id, workos_organization_id FROM workspace_directory ORDER BY workspace_id',
  ONLY_WORKSPACE ? [ONLY_WORKSPACE] : [],
);

async function inWorkspace(workspaceId, fn) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId]);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.user_id',
      '00000000-0000-4000-8000-000000000000',
    ]);
    const out = await fn();
    await client.query(FIX ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 1. Documents whose storage key no longer resolves
// ---------------------------------------------------------------------------
//
// The script cannot reach R2 — it runs wherever the restore happened, with a
// database credential and no Cloudflare one — so it reports the candidates and
// `--fix` marks the ones a `HERMES_MISSING_KEYS` list names. In the drill, that
// list comes from `wrangler r2 object get` over the reported keys.
{
  const missing = (process.env.HERMES_MISSING_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  let candidates = 0;
  let marked = 0;
  for (const { workspace_id: workspaceId } of workspaces) {
    await inWorkspace(workspaceId, async () => {
      const { rows } = await client.query(
        `SELECT id, storage_key, render_status FROM documents
          WHERE workspace_id = $1 AND render_status = 'ready' AND storage_key IS NOT NULL`,
        [workspaceId],
      );
      candidates += rows.length;
      if (FIX && missing.length > 0) {
        const { rowCount } = await client.query(
          `UPDATE documents
              SET render_status = 'missing', render_error = 'the object was not present after a restore'
            WHERE workspace_id = $1 AND storage_key = ANY($2::text[])`,
          [workspaceId, missing],
        );
        marked += rowCount ?? 0;
      }
    });
  }
  record(
    'documents',
    true,
    FIX
      ? `${candidates} documents claim a ready render; ${marked} marked missing from HERMES_MISSING_KEYS`
      : `${candidates} documents claim a ready render — check each storage_key exists in R2, then re-run with --fix and HERMES_MISSING_KEYS`,
  );
}

// ---------------------------------------------------------------------------
// 2. Membership reconciliation against WorkOS
// ---------------------------------------------------------------------------
//
// The port is the Worker's, and this script is Node with no Worker around it,
// so it calls the same WorkOS endpoint the port calls. That is deliberate
// duplication: the alternative is booting a Worker to run a reconciliation, and
// a restore is exactly the moment the Worker may not be up.
{
  const apiKey = process.env.WORKOS_API_KEY ?? '';
  if (!apiKey) {
    record('memberships', true, 'skipped: WORKOS_API_KEY is not set (expected in a local drill)');
  } else {
    const drift = [];
    for (const { workspace_id: workspaceId, workos_organization_id: org } of workspaces) {
      if (!org) continue;
      const response = await fetch(
        `https://api.workos.com/user_management/organization_memberships?organization_id=${encodeURIComponent(org)}&limit=100`,
        { headers: { authorization: `Bearer ${apiKey}` } },
      );
      if (!response.ok) {
        drift.push({ workspace_id: workspaceId, error: `WorkOS answered ${response.status}` });
        continue;
      }
      const body = await response.json();
      const live = new Map();
      for (const m of body.data ?? []) live.set(m.id, m.status);

      await inWorkspace(workspaceId, async () => {
        const { rows } = await client.query(
          `SELECT id, user_id, status, workos_membership_id FROM members WHERE workspace_id = $1`,
          [workspaceId],
        );
        for (const row of rows) {
          const theirs = row.workos_membership_id ? live.get(row.workos_membership_id) : undefined;
          const ours = row.status;
          // Active here and not active there is the dangerous direction: it is
          // somebody who was removed during the outage and can sign in again.
          if (ours === 'active' && theirs !== 'active') {
            drift.push({ workspace_id: workspaceId, member: row.id, ours, theirs: theirs ?? 'absent', risk: 'access' });
          }
          if (ours !== 'active' && theirs === 'active') {
            drift.push({ workspace_id: workspaceId, member: row.id, ours, theirs, risk: 'locked_out' });
          }
        }
        for (const [membershipId, status] of live) {
          if (status !== 'active') continue;
          if (!rows.some((row) => row.workos_membership_id === membershipId)) {
            drift.push({ workspace_id: workspaceId, workos_membership_id: membershipId, risk: 'missing_here' });
          }
        }
      });
    }
    record('memberships', drift.length === 0, `${drift.length} memberships disagree with WorkOS`, drift);
  }
}

// ---------------------------------------------------------------------------
// 3. The live-KEK check
// ---------------------------------------------------------------------------
//
// It does not decrypt anything: this script holds no KEK and should not. It
// reports which KEK versions the restored rows are wrapped under, and the human
// checks that every one of them is still a secret in the target environment.
// Deleting `KEK_V1` the day after a rotation is what makes last week's dump
// unreadable, and this is the check that catches it before a run does.
{
  const versions = new Map();
  for (const { workspace_id: workspaceId } of workspaces) {
    await inWorkspace(workspaceId, async () => {
      const { rows } = await client.query(
        `SELECT kek_version, count(*)::int AS n FROM workspace_provider_keys
          WHERE workspace_id = $1 AND revoked_at IS NULL GROUP BY kek_version`,
        [workspaceId],
      );
      for (const row of rows) versions.set(row.kek_version, (versions.get(row.kek_version) ?? 0) + row.n);
    });
  }
  const list = [...versions.entries()].map(([version, n]) => ({ kek_version: version, keys: n }));
  // `''.split(',')` is `['']` and `Number('')` is 0, so the empty case has to
  // be filtered before the parse or "unset" reads as "this environment holds
  // version 0" — which would report every real key as unreadable.
  const available = (process.env.HERMES_KEK_VERSIONS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map(Number)
    .filter((v) => Number.isFinite(v));
  const unreadable = available.length === 0 ? [] : list.filter((row) => !available.includes(row.kek_version));
  record(
    'kek',
    unreadable.length === 0,
    available.length === 0
      ? `live keys are wrapped under KEK versions ${list.map((r) => r.kek_version).join(', ') || '(none)'} — set HERMES_KEK_VERSIONS to the versions this environment holds to assert`
      : `${unreadable.length} KEK versions in the restored data are not held by this environment`,
    unreadable,
  );
}

// ---------------------------------------------------------------------------
// 4. Orphan instances
// ---------------------------------------------------------------------------
//
// Reported, not terminated: terminating needs the Cloudflare API and this
// script has a database credential. The output is the exact list of instance
// ids to feed to `wrangler workflows instances terminate`, and the runbook's
// restore section says to do that before letting traffic back in.
{
  const orphans = [];
  for (const { workspace_id: workspaceId } of workspaces) {
    await inWorkspace(workspaceId, async () => {
      const { rows } = await client.query(
        `SELECT id, attempt, status, workflow_instance_id FROM runs
          WHERE workspace_id = $1 AND status IN ('working', 'waiting')`,
        [workspaceId],
      );
      for (const row of rows) {
        orphans.push({
          workspace_id: workspaceId,
          run_id: row.id,
          attempt: row.attempt,
          status: row.status,
          instance_id: row.workflow_instance_id ?? `${row.id}-a${row.attempt}`,
        });
      }
    });
  }
  record(
    'instances',
    true,
    `${orphans.length} runs are working or waiting in the restored data; terminate any instance not in this list, ` +
      'and any instance whose attempt is ahead of its row, before letting traffic in',
    orphans,
  );
}

await client.end();

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length} of ${results.length} checks passed`);
if (failed.length > 0) {
  console.log('see docs/RUNBOOK.md, "Restore drill" and scripts/restore-drill.md');
  process.exit(1);
}
