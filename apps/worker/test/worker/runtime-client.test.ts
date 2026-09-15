// Node mocks do not enforce native fetch receiver rules or workerd's supported
// redirect modes. Keep this smoke test on the default transport in workerd.
import { describe, expect, it } from 'vitest';
import { HermesApiError, HermesClient } from '../../src/runtime/client.js';

describe('official Hermes native Worker transport', () => {
  it('submits and reconciles a native run through the default workerd fetch', async () => {
    const client = new HermesClient('https://runtime-transport.test', 'worker-test-only');
    const id = await client.submit({ input: 'Review the application.' }, 'worker-stable-key');
    expect(id).toBe('run_workerd');
    expect(await client.status(id)).toMatchObject({ run_id: id, status: 'completed', output: 'Reviewed in workerd.' });
  });

  it('rejects an upstream redirect in workerd before following it to another host', async () => {
    const client = new HermesClient('https://runtime-transport.test', 'worker-test-only');
    await expect(client.status('run_redirect')).rejects.toEqual(new HermesApiError(302, 'request'));
  });
});
