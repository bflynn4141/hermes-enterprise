// Tests that need no runtime at all: the Workflow id rule, and the parts of
// wrangler.jsonc whose drift would only be discovered during an incident.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STEP_OPTIONS,
  WORKFLOW_ID_MAX_LENGTH,
  WORKFLOW_ID_PATTERN,
  runAttemptInstanceId,
  stepNames,
} from '../../src/runs/workflow.js';

/** wrangler.jsonc is JSONC; the comments are the point, so they are stripped. */
function readWranglerConfig(): Record<string, unknown> {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../../wrangler.jsonc');
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
  return JSON.parse(text) as Record<string, unknown>;
}

const config = readWranglerConfig();
const envs = config.env as Record<string, Record<string, unknown>>;

describe('Workflow instance ids', () => {
  it('builds `${run_id}-a${attempt}` and it satisfies the documented pattern', () => {
    const id = runAttemptInstanceId('7b3f1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7c', 2);
    expect(id).toBe('7b3f1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7c-a2');
    expect(WORKFLOW_ID_PATTERN.test(id)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(WORKFLOW_ID_MAX_LENGTH);
    // Instance ids cannot contain a slash, which is why the attempt is a
    // suffix rather than a path segment.
    expect(id).not.toContain('/');
  });

  it('refuses an id that would not be accepted by the platform', () => {
    expect(() => runAttemptInstanceId('run/1', 1)).toThrow();
    expect(() => runAttemptInstanceId('x'.repeat(120), 1)).toThrow();
  });

  it('names steps deterministically, because the name is the checkpoint key', () => {
    expect(stepNames.provider(3)).toBe('turn-3-provider');
    expect(stepNames.tool(3, 'call_42')).toBe('turn-3-tool-call_42');
    expect(stepNames.provider(3)).toBe(stepNames.provider(3));
  });

  it('overrides the default step timeout, which is too short for a Max turn', () => {
    expect(STEP_OPTIONS.provider.timeout).toBe('30 minutes');
    expect(STEP_OPTIONS.tool.timeout).toBe('2 minutes');
    expect(STEP_OPTIONS.provider.retries.limit).toBe(3);
  });
});

describe('wrangler.jsonc', () => {
  it('declares both environments', () => {
    expect(Object.keys(envs).sort()).toEqual(['production', 'staging']);
  });

  it('declares the same Durable Object classes in every environment', () => {
    const classesOf = (scope: Record<string, unknown>): string[] =>
      Object.keys((scope.exports ?? {}) as Record<string, unknown>).sort();
    const top = classesOf(config);
    expect(top).toEqual(['SessionHub', 'WorkspaceHub']);
    for (const [name, scope] of Object.entries(envs)) {
      expect(classesOf(scope), `${name} declares different Durable Object classes`).toEqual(top);
    }
  });

  it('uses `exports` rather than `migrations`, and never both', () => {
    expect(config.exports).toBeDefined();
    expect(config.migrations).toBeUndefined();
    for (const scope of Object.values(envs)) expect(scope.migrations).toBeUndefined();
  });

  it('gives every queue a dead-letter queue, except the dead-letter queues', () => {
    for (const scope of [config, ...Object.values(envs)]) {
      const queues = scope.queues as { consumers: { queue: string; dead_letter_queue?: string }[] };
      for (const consumer of queues.consumers) {
        if (consumer.queue.endsWith('-dlq')) continue;
        // Without one, an exhausted message is deleted and the row it was
        // about says "preparing" forever.
        expect(consumer.dead_letter_queue, `${consumer.queue} has no dead-letter queue`).toBeTruthy();
      }
    }
  });

  it('sets a CPU limit and both cron triggers everywhere', () => {
    for (const scope of [config, ...Object.values(envs)]) {
      expect((scope.limits as { cpu_ms: number }).cpu_ms).toBe(30000);
      expect((scope.triggers as { crons: string[] }).crons).toEqual(['* * * * *', '17 3 * * *']);
    }
  });

  it('binds both Hyperdrive configs everywhere, one per database role', () => {
    for (const scope of [config, ...Object.values(envs)]) {
      const bindings = (scope.hyperdrive as { binding: string }[]).map((h) => h.binding).sort();
      expect(bindings).toEqual(['HYPERDRIVE_AGENT', 'HYPERDRIVE_APP']);
    }
  });

  it('serves the client with SPA fallback and keeps the API ahead of it', () => {
    for (const scope of [config, ...Object.values(envs)]) {
      const assets = scope.assets as { not_found_handling: string; run_worker_first: string[] };
      expect(assets.not_found_handling).toBe('single-page-application');
      expect(assets.run_worker_first).toContain('/w/*');
      expect(assets.run_worker_first).toContain('/health');
    }
  });

  it('never carries a secret, only variable names', () => {
    const text = JSON.stringify(config);
    for (const secret of [
      'WORKOS_API_KEY',
      'WORKOS_COOKIE_PASSWORD',
      'KEK_V1',
      'SENTRY_DSN',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'localConnectionString',
    ]) {
      expect(text, `${secret} appears in wrangler.jsonc`).not.toContain(secret);
    }
  });

  it('binds an uploads bucket everywhere, and a backup bucket only where one exists', () => {
    const bindingsOf = (scope: Record<string, unknown>): string[] =>
      ((scope.r2_buckets ?? []) as { binding: string }[]).map((b) => b.binding).sort();
    // Local development has no second bucket, and `backup_uploads` logs that it
    // did nothing rather than failing forever.
    expect(bindingsOf(config)).toEqual(['UPLOADS']);
    for (const [name, scope] of Object.entries(envs)) {
      expect(bindingsOf(scope), `${name} binds different buckets`).toEqual(['BACKUP_UPLOADS', 'UPLOADS']);
      // A presigned URL has to spell the bucket out; a binding cannot.
      expect((scope.vars as { R2_BUCKET?: string }).R2_BUCKET, `${name} has no bucket name`).toBeTruthy();
    }
  });

  it('offers OpenRouter and nothing else, in all three environments', () => {
    // Development is `config.vars`; staging and production are the two in
    // `env`. The variable is what `model/allowed.ts` reads, and an environment
    // that lost it would be the one place the other three adapters became
    // reachable from a route (decision R12). A missing value fails closed in
    // code, but an environment that disagrees with the other two is a
    // deployment nobody meant to make.
    expect((config.vars as { ALLOWED_PROVIDERS: string }).ALLOWED_PROVIDERS).toBe('openrouter');
    for (const [name, scope] of Object.entries(envs)) {
      expect((scope.vars as { ALLOWED_PROVIDERS: string }).ALLOWED_PROVIDERS, `${name} offers other providers`).toBe(
        'openrouter',
      );
    }
  });

  it('uses fake auth only in local development', () => {
    expect((config.vars as { AUTH_MODE: string }).AUTH_MODE).toBe('fake');
    for (const [name, scope] of Object.entries(envs)) {
      expect((scope.vars as { AUTH_MODE: string }).AUTH_MODE, `${name} trusts a header`).toBe('workos');
    }
  });
});
