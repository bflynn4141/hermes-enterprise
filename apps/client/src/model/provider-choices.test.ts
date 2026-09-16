// The client's half of the Nous Portal provider decision.
//
// Three of these are copy assertions, which is unusual and deliberate: the
// strings are the product's answer to "what do I do now", the server's refusals
// are written to match them, and a rename that leaves one of them saying
// "add a DeepSeek key" is exactly the drift nobody notices in a diff.
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '@hermes/shared';
import { DEFAULT_PROVIDER, EMPTY, PROVIDER_CHOICES } from './constants.js';
import { createMockBackend } from './mock.js';

describe('the Add-a-key dialog', () => {
  it('offers Nous Portal and nothing else', () => {
    expect(PROVIDER_CHOICES.map((choice) => choice.id)).toEqual(['nous_portal']);
    expect(DEFAULT_PROVIDER).toBe('nous_portal');
    // Every id it does offer is a provider the contract knows, so the dialog
    // cannot post something the route answers `unknown_provider` to.
    for (const choice of PROVIDER_CHOICES) expect(PROVIDERS).toContain(choice.id);
  });

  it('says what a key unlocks, in the words the empty states use', () => {
    expect(EMPTY.providerKeys).toBe('Connect Nous Portal to enable models');
    expect(EMPTY.noKey).toBe('Connect Nous Portal in Settings to start');
    expect(EMPTY.keyNotAllowed).toContain('only Nous Portal keys');
  });

  it('names no other provider in any empty state', () => {
    const copy = Object.values(EMPTY)
      .map((value) => (typeof value === 'function' ? value('x') : value))
      .join(' ');
    for (const gone of ['DeepSeek', 'Anthropic', 'OpenAI']) expect(copy).not.toContain(gone);
  });
});

describe('the mock bundle', () => {
  // The mock is the client's fixture of the server, and the server's catalog
  // route answers with allowed providers only. A mock still serving DeepSeek
  // rows would teach the client's own scenarios about a screen that is gone.
  it('is a fixture of the product, so it serves only Nous Portal rows', async () => {
    const mock = createMockBackend();
    const catalog = (await (await mock.fetchImpl(`/w/${mock.workspaceId}/catalog`)).json()) as {
      models: { provider: string }[];
    };
    expect(catalog.models.length).toBeGreaterThan(0);
    for (const row of catalog.models) expect(row.provider).toBe('nous_portal');

    const keys = (await (await mock.fetchImpl(`/w/${mock.workspaceId}/provider-keys`)).json()) as {
      keys: { provider: string }[];
    };
    expect(keys.keys.length).toBeGreaterThan(0);
    for (const key of keys.keys) expect(key.provider).toBe('nous_portal');
  });
});
