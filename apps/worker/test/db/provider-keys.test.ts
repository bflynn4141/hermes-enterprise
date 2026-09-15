// The key store against the real database.
//
// The unit tests prove the cryptography; these prove the parts that only exist
// once there is a Postgres underneath: that row-level security and the AAD
// agree, that a rotation keeps exactly one live key, that a removal actually
// stops the runs that were using the key and zeroes the bytes, that the catalog
// flips from "add a key" to offered when a key verifies, and that the caps the
// engine reads are computed from `model_calls` and `runs` rather than from a
// counter.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Tx } from '../../src/db/client.js';
import {
  addProviderKey,
  findByFingerprint,
  listProviderKeys,
  openKeyForVerification,
  removeProviderKey,
  resolveKey,
  rewrapProviderKey,
  rotateProviderKey,
  setKeyStatus,
  KeyStoreError,
} from '../../src/keys/store.js';
import { listRotationTargets, runKekRotation } from '../../src/keys/rotation.js';
import { enqueueWeeklyReverify, defaultProbeModel } from '../../src/keys/reverify.js';
import { probeKey, recordVerification, forbiddenCountFor } from '../../src/keys/verify.js';
import { SCRIPTS, ScriptedProvider } from '../../src/model/scripted.js';
import { loadCatalog, loadModel } from '../../src/model/catalog.js';
import { checkCaps, recordModelCall } from '../../src/model/usage.js';
import { ZERO_USAGE } from '../../src/model/types.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

/** A deterministic 32-byte KEK, generated so no secret-shaped literal is here. */
function kek(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 17 + i * 11) % 256;
  return Buffer.from(bytes).toString('base64');
}

const ENV_V1 = { KEK_V1: kek(1) };
const ENV_V1_V2 = { KEK_V1: kek(1), KEK_V2: kek(2), KEK_CURRENT: '2' };

const KEY_A = ['sk', 'ant', 'api03', 'FIRSTKEY0000000000000000'].join('-');
const KEY_B = ['sk', 'ant', 'api03', 'SECONDKEY000000000000000'].join('-');

/** Run `fn` inside a committed transaction with the tenant key set. */
async function asTenant<T>(fx: Fixture, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    try {
      const result = await fn(c as unknown as Tx);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

async function seedRun(fx: Fixture): Promise<string> {
  const runId = randomUUID();
  await asTenant(fx, async (tx) => {
    await tx.query(
      `INSERT INTO runs (id, workspace_id, session_id, model_id, client_turn_id, status)
       VALUES ($1, $2, $3, 'deepseek-flash', $4, 'working')`,
      [runId, fx.workspaceId, fx.sessionId, `turn-${runId}`],
    );
  });
  return runId;
}

describe('storing a provider key', () => {
  it('round-trips through Postgres and never stores the key in the clear', async () => {
    const fx = await seedWorkspace();

    const stored = await asTenant(fx, (tx) =>
      addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'anthropic',
        label: 'Ops key',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      }),
    );

    expect(stored.status).toBe('unverified');
    expect(stored.last4).toBe(KEY_A.slice(-4));
    expect(stored.fingerprint_prefix).toHaveLength(12);

    // The bytes on disk are not the key.
    const raw = await asTenant(fx, async (tx) => {
      const { rows } = await tx.query<{ ciphertext: Uint8Array }>(
        'SELECT ciphertext FROM workspace_provider_keys WHERE id = $1',
        [stored.id],
      );
      return rows[0]?.ciphertext;
    });
    expect(new TextDecoder().decode(raw)).not.toContain('FIRSTKEY');

    // A key is not usable until it verifies, which is the whole point of the
    // status: an unverified row must not be able to pay for a run.
    await expect(asTenant(fx, (tx) => resolveKey(tx, ENV_V1, fx.workspaceId, 'anthropic'))).rejects.toMatchObject({
      reason: 'no_usable_key',
    });

    await asTenant(fx, (tx) => setKeyStatus(tx, fx.workspaceId, stored.id, 'verified', ['claude-sonnet-4-6']));
    const resolved = await asTenant(fx, (tx) => resolveKey(tx, ENV_V1, fx.workspaceId, 'anthropic'));
    expect(resolved.apiKey).toBe(KEY_A);
    expect(resolved.keyId).toBe(stored.id);
  });

  it('cannot be read as another workspace', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();

    const stored = await asTenant(mine, async (tx) => {
      const key = await addProviderKey(tx, ENV_V1, {
        workspaceId: mine.workspaceId,
        provider: 'anthropic',
        label: '',
        plaintext: KEY_A,
        addedBy: mine.adminId,
      });
      return setKeyStatus(tx, mine.workspaceId, key.id, 'verified', []);
    });

    // Row-level security: the other tenant simply cannot see the row.
    await expect(asTenant(theirs, (tx) => resolveKey(tx, ENV_V1, theirs.workspaceId, 'anthropic'))).rejects.toThrow(
      KeyStoreError,
    );

    // And the AAD, independently: even holding the row and reading it under the
    // other workspace's id fails to decrypt. Either check alone is enough,
    // which is why there are two.
    const envelope = await asTenant(mine, async (tx) => {
      const { rows } = await tx.query(
        'SELECT ciphertext, iv, wrapped_dek, wrap_iv, kek_version FROM workspace_provider_keys WHERE id = $1',
        [stored.id],
      );
      return rows[0] as unknown as {
        ciphertext: Buffer;
        iv: Buffer;
        wrapped_dek: Buffer;
        wrap_iv: Buffer;
        kek_version: number;
      };
    });
    const { openKey } = await import('../../src/keys/envelope.js');
    await expect(
      openKey(ENV_V1, { workspaceId: theirs.workspaceId, keyId: stored.id }, {
        ciphertext: new Uint8Array(envelope.ciphertext),
        iv: new Uint8Array(envelope.iv),
        wrappedDek: new Uint8Array(envelope.wrapped_dek),
        wrapIv: new Uint8Array(envelope.wrap_iv),
        kekVersion: envelope.kek_version,
      }),
    ).rejects.toThrow(/did not authenticate/);
  });

  it('recognises a re-pasted key by fingerprint without decrypting anything', async () => {
    const fx = await seedWorkspace();
    const stored = await asTenant(fx, (tx) =>
      addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'deepseek',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      }),
    );

    expect((await asTenant(fx, (tx) => findByFingerprint(tx, fx.workspaceId, KEY_A)))?.id).toBe(stored.id);
    expect(await asTenant(fx, (tx) => findByFingerprint(tx, fx.workspaceId, KEY_B))).toBeNull();
  });
});

describe('rotating a key', () => {
  it('leaves exactly one live row, chained to the one it replaced', async () => {
    const fx = await seedWorkspace();
    const first = await asTenant(fx, (tx) =>
      addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'anthropic',
        label: 'Original',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      }),
    );

    const { key, previous } = await asTenant(fx, (tx) =>
      rotateProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'anthropic',
        label: 'Rotated',
        plaintext: KEY_B,
        addedBy: fx.adminId,
        previousKeyId: first.id,
      }),
    );

    expect(previous.status).toBe('revoked');
    expect(key.replaces_key_id).toBe(first.id);

    const all = await asTenant(fx, (tx) => listProviderKeys(tx, fx.workspaceId));
    expect(all).toHaveLength(2);
    // History stays: `model_calls.key_id` still points at a row that exists.
    expect(all.filter((k) => k.revoked_at === null)).toHaveLength(1);

    await asTenant(fx, (tx) => setKeyStatus(tx, fx.workspaceId, key.id, 'verified', []));
    expect((await asTenant(fx, (tx) => resolveKey(tx, ENV_V1, fx.workspaceId, 'anthropic'))).apiKey).toBe(KEY_B);
  });
});

describe('removing a key', () => {
  it('stops the runs that were using it and zeroes the ciphertext', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);

    const key = await asTenant(fx, async (tx) => {
      const added = await addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'anthropic',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      });
      await setKeyStatus(tx, fx.workspaceId, added.id, 'verified', []);
      await recordModelCall(tx, {
        workspaceId: fx.workspaceId,
        runId,
        turn: 1,
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        keyId: added.id,
        usage: { ...ZERO_USAGE, input_tokens: 1000, output_tokens: 100 },
        latencyMs: 900,
        status: 'ok',
        traceId: 'trace-1',
      });
      return added;
    });

    const removed = await asTenant(fx, (tx) => removeProviderKey(tx, fx.workspaceId, key.id));
    expect(removed.stoppedRuns).toEqual([runId]);
    expect(removed.key.status).toBe('revoked');

    const after = await asTenant(fx, async (tx) => {
      const run = await tx.query<{ stop_requested: boolean }>('SELECT stop_requested FROM runs WHERE id = $1', [runId]);
      const row = await tx.query<{ ciphertext: Buffer; wrapped_dek: Buffer }>(
        'SELECT ciphertext, wrapped_dek FROM workspace_provider_keys WHERE id = $1',
        [key.id],
      );
      return { run: run.rows[0], key: row.rows[0] };
    });

    expect(after.run?.stop_requested).toBe(true);
    // Zeroed rather than left behind, so a restore from backup cannot
    // resurrect a key the Admin deliberately removed.
    expect(after.key?.ciphertext).toEqual(Buffer.from([0]));
    expect(after.key?.wrapped_dek).toEqual(Buffer.from([0]));

    // The `model_calls` row still names the key, so Usage stays answerable.
    const calls = await asTenant(fx, (tx) =>
      tx.query<{ key_id: string; cost_usd_estimate: string }>('SELECT key_id, cost_usd_estimate FROM model_calls WHERE run_id = $1', [runId]),
    );
    expect(calls.rows[0]?.key_id).toBe(key.id);
  });

  it('refuses to remove a key twice', async () => {
    const fx = await seedWorkspace();
    const key = await asTenant(fx, (tx) =>
      addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'openai',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      }),
    );
    await asTenant(fx, (tx) => removeProviderKey(tx, fx.workspaceId, key.id));
    await expect(asTenant(fx, (tx) => removeProviderKey(tx, fx.workspaceId, key.id))).rejects.toMatchObject({
      reason: 'already_revoked',
    });
  });
});

describe('KEK rotation', () => {
  it('re-wraps every live key onto the new version, leaving the key readable', async () => {
    const one = await seedWorkspace();
    const two = await seedWorkspace();

    for (const fx of [one, two]) {
      await asTenant(fx, (tx) =>
        addProviderKey(tx, ENV_V1, {
          workspaceId: fx.workspaceId,
          provider: 'anthropic',
          label: '',
          plaintext: KEY_A,
          addedBy: fx.adminId,
        }),
      );
    }

    const byWorkspace = new Map([one, two].map((fx) => [fx.workspaceId, fx]));
    const report = await runKekRotation(ENV_V1_V2, {
      // No role can enumerate across tenants, so the workspace list comes from
      // the caller and the rows are read one workspace at a time, each inside
      // its own transaction. This is the shape the production Workflow has.
      listTargets: async (toVersion) => {
        const targets = [];
        for (const fx of [one, two]) {
          targets.push(...(await asTenant(fx, (tx) => listRotationTargets(tx, toVersion))));
        }
        return targets;
      },
      withWorkspace: (workspaceId, fn) => asTenant(byWorkspace.get(workspaceId) as Fixture, fn),
    });

    expect(report.toVersion).toBe(2);
    expect(report.rewrapped).toBe(2);
    expect(report.failed).toEqual([]);

    for (const fx of [one, two]) {
      const key = (await asTenant(fx, (tx) => listProviderKeys(tx, fx.workspaceId)))[0];
      await asTenant(fx, (tx) => setKeyStatus(tx, fx.workspaceId, key?.id ?? '', 'verified', []));
      // Encrypted under v1, rotated to v2, still readable — and readable with
      // the *new* environment, which is what a post-rotation deploy has.
      expect((await asTenant(fx, (tx) => resolveKey(tx, ENV_V1_V2, fx.workspaceId, 'anthropic'))).apiKey).toBe(KEY_A);
    }
  });

  it('does nothing for a row already on the target version', async () => {
    const fx = await seedWorkspace();
    const key = await asTenant(fx, (tx) =>
      addProviderKey(tx, ENV_V1_V2, {
        workspaceId: fx.workspaceId,
        provider: 'deepseek',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      }),
    );
    expect(await asTenant(fx, (tx) => rewrapProviderKey(tx, ENV_V1_V2, fx.workspaceId, key.id, 2))).toBe(false);
  });
});

describe('verification', () => {
  it('records a 200 as verified with the models the provider listed', async () => {
    const fx = await seedWorkspace();
    const key = await asTenant(fx, (tx) =>
      addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'deepseek',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      }),
    );

    const input = {
      workspaceId: fx.workspaceId,
      keyId: key.id,
      provider: 'deepseek',
      apiKey: KEY_A,
      probeModel: 'deepseek-flash',
      forbiddenCount: 0,
    };
    const outcome = await probeKey(new ScriptedProvider([SCRIPTS.completed_with_tool_call]), input);
    await asTenant(fx, (tx) => recordVerification(tx, input, outcome));

    const after = (await asTenant(fx, (tx) => listProviderKeys(tx, fx.workspaceId)))[0];
    expect(after?.status).toBe('verified');
    expect(after?.verified_models).toEqual(['deepseek-flash']);
    expect(after?.verified_at).not.toBeNull();
  });

  it('records a 401 as invalid and queues no retry', async () => {
    const fx = await seedWorkspace();
    const key = await asTenant(fx, (tx) =>
      addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'deepseek',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      }),
    );

    const input = {
      workspaceId: fx.workspaceId,
      keyId: key.id,
      provider: 'deepseek',
      apiKey: KEY_A,
      probeModel: 'deepseek-flash',
      forbiddenCount: 0,
    };
    const outcome = await probeKey(new ScriptedProvider([SCRIPTS.unauthorized]), input);
    expect(outcome.status).toBe('invalid');
    await asTenant(fx, (tx) => recordVerification(tx, input, outcome));

    const jobs = await asTenant(fx, (tx) =>
      tx.query('SELECT 1 FROM jobs WHERE workspace_id = $1 AND kind = $2', [fx.workspaceId, 'reverify']),
    );
    // Nothing to retry: the provider gave a verdict.
    expect(jobs.rowCount).toBe(0);
  });

  it('leaves a 403 unverified with a reverify job, then verifies scoped on the second one', async () => {
    const fx = await seedWorkspace();
    const key = await asTenant(fx, (tx) =>
      addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'anthropic',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      }),
    );
    const base = {
      workspaceId: fx.workspaceId,
      keyId: key.id,
      provider: 'anthropic',
      apiKey: KEY_A,
      probeModel: 'claude-sonnet-4-6',
    };

    const first = await probeKey(new ScriptedProvider([SCRIPTS.scoped_key]), { ...base, forbiddenCount: 0 });
    expect(first).toMatchObject({ status: 'unverified', reason: 'forbidden', retry: true, forbiddenCount: 1 });
    await asTenant(fx, (tx) => recordVerification(tx, { ...base, forbiddenCount: 0 }, first));
    expect(await asTenant(fx, (tx) => forbiddenCountFor(tx, fx.workspaceId, key.id))).toBe(1);

    const second = await probeKey(new ScriptedProvider([SCRIPTS.scoped_key]), { ...base, forbiddenCount: 1 });
    expect(second.status).toBe('verified_scoped');
    // A scoped key cannot enumerate, so the only model claimed is the one the
    // probe actually called.
    expect(second.models).toEqual(['claude-sonnet-4-6']);
    await asTenant(fx, (tx) => recordVerification(tx, { ...base, forbiddenCount: 1 }, second));

    const after = (await asTenant(fx, (tx) => listProviderKeys(tx, fx.workspaceId)))[0];
    expect(after?.status).toBe('verified_scoped');
  });

  it('decrypts an unverified row for Verify, which resolveKey refuses', async () => {
    const fx = await seedWorkspace();
    const key = await asTenant(fx, (tx) =>
      addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'openai',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      }),
    );
    expect(await asTenant(fx, (tx) => openKeyForVerification(tx, ENV_V1, fx.workspaceId, key.id))).toBe(KEY_A);
  });

  it('enqueues a weekly sweep for every key that is not revoked', async () => {
    const fx = await seedWorkspace();
    await asTenant(fx, async (tx) => {
      const key = await addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'deepseek',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      });
      await setKeyStatus(tx, fx.workspaceId, key.id, 'invalid', []);
    });

    expect(await asTenant(fx, (tx) => enqueueWeeklyReverify(tx, fx.workspaceId))).toBe(1);
    // Running it twice does not produce two jobs: the key carries the key id
    // and UNIQUE(kind, key) is global.
    expect(await asTenant(fx, (tx) => enqueueWeeklyReverify(tx, fx.workspaceId))).toBe(1);
    const jobs = await asTenant(fx, (tx) =>
      tx.query('SELECT 1 FROM jobs WHERE workspace_id = $1 AND kind = $2', [fx.workspaceId, 'reverify']),
    );
    expect(jobs.rowCount).toBe(1);
  });

  it('picks an offered catalog model to probe with', async () => {
    const fx = await seedWorkspace();
    expect(await asTenant(fx, (tx) => defaultProbeModel(tx, 'deepseek'))).toBe('deepseek-flash');
    // Anthropic has one offered row and one the pilot disables; the offered one
    // wins, because probing with a row the pilot cannot call would report the
    // catalog's problem as the key's.
    expect(await asTenant(fx, (tx) => defaultProbeModel(tx, 'anthropic'))).toBe('claude-sonnet-4-6');
  });
});

describe('the catalog a workspace sees', () => {
  it('offers nothing until a key verifies, and says what to do instead', async () => {
    const fx = await seedWorkspace();
    const before = await asTenant(fx, (tx) => loadCatalog(tx, fx.workspaceId));

    expect(before.every((row) => row.enabled === false)).toBe(true);
    const sonnet = before.find((r) => r.model_id === 'claude-sonnet-4-6');
    expect(sonnet?.disabled_code).toBe('no_key');
    expect(sonnet?.disabled_reason).toContain('Add your Anthropic key');
    // Catalog policy is a different answer from "you have no key", and stays
    // that answer whatever the workspace does about keys.
    expect(before.find((r) => r.model_id === 'claude-opus-4-7')?.disabled_code).toBe('catalog');
    expect(before.find((r) => r.model_id === 'gpt-5-5')?.disabled_code).toBe('catalog');
    expect(sonnet?.pricing_verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('enables exactly the rows for a provider whose key verified', async () => {
    const fx = await seedWorkspace();
    await asTenant(fx, async (tx) => {
      const key = await addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'anthropic',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      });
      await setKeyStatus(tx, fx.workspaceId, key.id, 'verified', ['claude-sonnet-4-6']);
    });

    const after = await asTenant(fx, (tx) => loadCatalog(tx, fx.workspaceId));
    expect(after.filter((r) => r.enabled).map((r) => r.model_id)).toEqual(['claude-sonnet-4-6']);
    // The Opus row is still off: a key does not overrule the catalog.
    expect(after.find((r) => r.model_id === 'claude-opus-4-7')?.enabled).toBe(false);
    expect(after.find((r) => r.model_id === 'deepseek-flash')?.disabled_code).toBe('no_key');
  });

  it('names an invalid key rather than pretending there is none', async () => {
    const fx = await seedWorkspace();
    await asTenant(fx, async (tx) => {
      const key = await addProviderKey(tx, ENV_V1, {
        workspaceId: fx.workspaceId,
        provider: 'deepseek',
        label: '',
        plaintext: KEY_A,
        addedBy: fx.adminId,
      });
      await setKeyStatus(tx, fx.workspaceId, key.id, 'invalid', []);
    });
    const row = (await asTenant(fx, (tx) => loadCatalog(tx, fx.workspaceId))).find(
      (r) => r.model_id === 'deepseek-flash',
    );
    expect(row?.disabled_code).toBe('key_invalid');
    expect(row?.disabled_reason).toContain('rejected');
  });
});

describe('model_calls and the caps', () => {
  it('prices a call from the catalog rather than from the caller', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);

    const { cost_usd_estimate } = await asTenant(fx, (tx) =>
      recordModelCall(tx, {
        workspaceId: fx.workspaceId,
        runId,
        turn: 1,
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        keyId: null,
        usage: { input_tokens: 1_000_000, output_tokens: 100_000, cached_input_tokens: 0, reasoning_tokens: 0 },
        latencyMs: 1200,
        status: 'ok',
        traceId: 'trace-2',
      }),
    );
    // $3 per million input, $15 per million output.
    expect(cost_usd_estimate).toBeCloseTo(4.5, 6);

    const model = await asTenant(fx, (tx) => loadModel(tx, 'claude-sonnet-4-6'));
    expect(model?.transport).toBe('anthropic_messages');
    expect(model?.effort_map).toEqual({ low: 'low', medium: 'medium', high: 'high', max: 'max' });
  });

  it('refuses a new run once the daily token cap is reached', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);

    const before = await asTenant(fx, (tx) => checkCaps(tx, fx.workspaceId));
    expect(before.allowed).toBe(true);
    expect(before.dailyTokenCap).toBeNull();

    await asTenant(fx, async (tx) => {
      await tx.query('UPDATE workspace_settings SET daily_token_cap = 1000 WHERE workspace_id = $1', [fx.workspaceId]);
      await recordModelCall(tx, {
        workspaceId: fx.workspaceId,
        runId,
        turn: 1,
        modelId: 'deepseek-flash',
        provider: 'deepseek',
        keyId: null,
        usage: { ...ZERO_USAGE, input_tokens: 900, output_tokens: 200 },
        latencyMs: null,
        status: 'ok',
        traceId: null,
      });
    });

    const after = await asTenant(fx, (tx) => checkCaps(tx, fx.workspaceId));
    expect(after.tokensToday).toBe(1100);
    expect(after.allowed).toBe(false);
    expect(after.reason).toBe('daily_token_cap');
    expect(after.warn).toBe(true);
  });

  it('refuses a new run once max_concurrent_runs is reached, counting working runs only', async () => {
    const fx = await seedWorkspace();
    await asTenant(fx, (tx) =>
      tx.query('UPDATE workspace_settings SET max_concurrent_runs = 1 WHERE workspace_id = $1', [fx.workspaceId]),
    );
    const runId = await seedRun(fx);

    expect(await asTenant(fx, (tx) => checkCaps(tx, fx.workspaceId))).toMatchObject({
      allowed: false,
      reason: 'max_concurrent_runs',
      activeRuns: 1,
    });

    // A waiting run is blocked on a human and holds no compute: it must not
    // count, or a workspace whose runs are all waiting could never start one.
    await asTenant(fx, (tx) => tx.query(`UPDATE runs SET status = 'waiting' WHERE id = $1`, [runId]));
    expect(await asTenant(fx, (tx) => checkCaps(tx, fx.workspaceId))).toMatchObject({ allowed: true, activeRuns: 0 });
  });
});
