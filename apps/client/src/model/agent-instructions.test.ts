import { describe, expect, it, vi } from 'vitest';
import { createRest } from './rest.js';
import { createAuth } from './auth.js';

const workspace = '00000000-0000-4000-8000-000000000001';
const agent = '00000000-0000-4000-8000-000000000004';
const id = '00000000-0000-4000-8000-000000000005';
const instruction = { id, state: 'current', text: 'Use evidence.', before: null, provenance: 'written by a person', created_at: '2026-09-19T00:00:00Z', version: 0 };

describe('agent instruction REST boundary', () => {
  it('includes the selected agent, current version guard and Skills origin on a direct edit', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(instruction), { status: 201 }));
    const rest = createRest({ auth: createAuth('fake'), fetchImpl });
    await rest.saveInstruction(workspace, agent, { text: 'Use evidence.', expected_current_id: id });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/w/${workspace}/instructions?agent_id=${agent}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Use evidence.', expected_current_id: id });
    expect(new Headers(init.headers).get('X-Requested-From')).toBe('skills');
  });

  it('never retries a stale edit or masks a denied instruction list as empty', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'Changed', reason: 'stale_revision' }), { status: 409 }));
    const rest = createRest({ auth: createAuth('fake'), fetchImpl });
    await expect(rest.saveInstruction(workspace, agent, { text: 'Use evidence.', expected_current_id: id })).rejects.toMatchObject({ reason: 'stale_revision' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(rest.listInstructions(workspace, agent)).rejects.toMatchObject({ status: 409 });
  });
});
