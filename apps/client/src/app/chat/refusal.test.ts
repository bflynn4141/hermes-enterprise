// What the composer says when the server refuses a turn.
//
// Every case here began as a real refusal that produced nothing on screen: the
// composer's three send paths all ended in `.catch(() => undefined)`, so the
// most useful sentence in the system — the server's own — was thrown away
// (decision C45).
import { describe, expect, it } from 'vitest';
import { RestError } from '../../model/rest.js';
import { refusalFor } from './refusal.js';

describe('refusalFor', () => {
  it('names the provider for a missing key, and the way to fix it', () => {
    const refusal = refusalFor(new RestError(400, 'no_key', 'Add a deepseek key in Settings to start'), { provider: 'nous_portal' });
    expect(refusal.text).toBe('Connect Nous Portal to start. Nothing was sent, and your draft is still here.');
    expect(refusal.action).toEqual({ label: 'Admin → Model providers', target: 'provider-keys' });
    expect(refusal.actionable).toBe(true);
  });

  it('never shows a provider slug or the server’s copy', () => {
    const refusal = refusalFor(new RestError(400, 'key_invalid', 'Your nous_portal key was rejected'), { provider: 'nous_portal' });
    expect(refusal.text).toContain('Nous Portal');
    expect(refusal.text).not.toContain('nous_portal');
  });

  it('says a cap in plain words, with no action', () => {
    const refusal = refusalFor(new RestError(429, 'max_concurrent_runs', 'this workspace already has as many runs as it allows'));
    expect(refusal.text).toBe('This workspace is already running as many tasks as it allows. Try again when one finishes.');
    expect(refusal.action).toBeNull();
    expect(refusal.actionable).toBe(false);
  });

  it('maps the refusals whose server text used to leak', () => {
    expect(refusalFor(new RestError(409, 'run_in_flight', 'this session already has a run in flight'), { agentName: 'Iris' }).text)
      .toBe('Iris is still working on your last message. Wait for it to finish, or stop it first.');
    expect(refusalFor(new RestError(429, 'rate_limited', 'run.turn is limited to 30 per 60 seconds')).text).not.toMatch(/run\.turn|60 seconds/);
    expect(refusalFor(new RestError(409, 'engine_paused', 'the engine is paused for a deploy')).text).not.toMatch(/engine|deploy/);
  });

  it('says the agent is paused, and that the draft is kept', () => {
    const refusal = refusalFor(new RestError(503, 'engine_paused', ''));
    expect(refusal.text).toMatch(/updating/i);
    expect(refusal.text).toMatch(/draft/i);
  });

  it('gives a reason it has never seen a generic sentence, not the server’s', () => {
    const refusal = refusalFor(new RestError(422, 'brand_new_reason', 'internal detail nobody should read'));
    expect(refusal.text).toBe('Something went wrong. Nothing was sent, and your draft is still here.');
    expect(refusal.action).toBeNull();
  });

  it('has a sentence for a request that never reached a Worker', () => {
    expect(refusalFor(new TypeError('Failed to fetch')).text).toMatch(/did not reach/);
    expect(refusalFor(null).text).toMatch(/did not reach/);
  });

  it('never returns an empty string', () => {
    for (const reason of ['no_key', 'max_concurrent_runs', 'engine_paused', 'reauth_required', 'anything']) {
      expect(refusalFor(new RestError(400, reason, '')).text.length).toBeGreaterThan(0);
    }
  });
});
