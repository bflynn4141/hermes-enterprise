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
  it('shows the server’s sentence for a missing key, and the way to fix it', () => {
    const refusal = refusalFor(new RestError(400, 'no_key', 'Add a deepseek key in Settings to start'));
    expect(refusal.text).toBe('Add a deepseek key in Settings to start');
    expect(refusal.action).toEqual({ label: 'Settings → Provider keys', target: 'provider-keys' });
    expect(refusal.actionable).toBe(true);
  });

  it('never rewrites the provider name out of the server’s copy', () => {
    const refusal = refusalFor(new RestError(400, 'no_key', 'Add an openrouter key in Settings to start'));
    expect(refusal.text).toContain('openrouter');
  });

  it('shows a cap as the server worded it, with no action', () => {
    const refusal = refusalFor(new RestError(429, 'max_concurrent_runs', 'this workspace already has as many runs as it allows'));
    expect(refusal.text).toBe('this workspace already has as many runs as it allows');
    expect(refusal.action).toBeNull();
    expect(refusal.actionable).toBe(false);
  });

  it('says the agent is paused, and that the draft is kept', () => {
    const refusal = refusalFor(new RestError(503, 'engine_paused', ''));
    expect(refusal.text).toMatch(/paused/i);
    expect(refusal.text).toMatch(/draft/i);
  });

  it('passes a reason it has never seen straight through', () => {
    const refusal = refusalFor(new RestError(422, 'model_not_in_catalog', 'That model is not in this workspace’s catalog'));
    expect(refusal.text).toBe('That model is not in this workspace’s catalog');
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
