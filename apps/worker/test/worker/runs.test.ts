// The run engine, in the real runtime.
//
// What only workerd can prove: that `RunAttempt` is a class the Workflows
// binding accepts, that `cloudflare:workflows` really exports the
// `NonRetryableError` the engine throws, and that the SessionHub's `forward`
// RPC — the one the engine calls once per delta batch and reads Stop from —
// exists on the stub the Worker holds. Everything about what the loop *does*
// is the Node engine tests' subject, because a failure taxonomy that can only
// be exercised in a deployed runtime is a taxonomy nobody runs.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { NonRetryableError } from 'cloudflare:workflows';
import { RunAttempt, runAttemptInstanceId, providerFactory } from '../../src/runs/workflow.js';

describe('the Workflow', () => {
  it('is registered under the binding the config names', () => {
    expect(env.RUN_ATTEMPT).toBeDefined();
    expect(typeof env.RUN_ATTEMPT.create).toBe('function');
    expect(typeof env.RUN_ATTEMPT.get).toBe('function');
  });

  it('is a class the runtime can construct as a WorkflowEntrypoint', () => {
    expect(typeof RunAttempt).toBe('function');
    expect(RunAttempt.prototype.run).toBeInstanceOf(Function);
  });

  it('exports the real NonRetryableError, which is how a permanent class stops', () => {
    const error = new NonRetryableError('permanent');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NonRetryableError');
  });

  it('builds instance ids the platform accepts', () => {
    const id = runAttemptInstanceId('7b3f1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7c', 3);
    expect(id).toBe('7b3f1a2c-9d4e-4f6a-8b1c-2d3e4f5a6b7c-a3');
    expect(id).not.toContain('/');
  });

  it('serves the scripted provider in development and refuses it anywhere else', () => {
    expect(providerFactory({ ...env, MODEL_SCRIPTED: '1', ENVIRONMENT: 'development' })('deepseek_chat').provider).toBe(
      'scripted',
    );
    expect(() => providerFactory({ ...env, MODEL_SCRIPTED: '1', ENVIRONMENT: 'production' })).toThrow(
      /development-only/,
    );
    expect(providerFactory({ ...env, MODEL_SCRIPTED: '0' })('deepseek_chat').provider).toBe('deepseek');
  });
});

describe('the SessionHub RPC the engine uses', () => {
  it('forwards a batch and answers with Stop in the same round trip', async () => {
    const id = env.SESSION_HUB.idFromName('workerd-test-session');
    const stub = env.SESSION_HUB.get(id);

    const before = await stub.forward('run-1', []);
    expect(before.stop_requested).toBe(false);

    await stub.requestStop('run-1');
    const after = await stub.forward('run-1', []);
    expect(after.stop_requested).toBe(true);
    // Another run in the same session is unaffected: the flag is per run.
    expect((await stub.forward('run-2', [])).stop_requested).toBe(false);
  });
});

describe('the turns route in workerd', () => {
  it('is mounted, and refuses an unauthenticated caller before touching the engine', async () => {
    const response = await SELF.fetch(
      'https://hermes.test/w/00000000-0000-4000-8000-000000000001/sessions/00000000-0000-4000-8000-000000000002/turns',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_turn_id: 'x' }) },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'no_session' });
  });
});
