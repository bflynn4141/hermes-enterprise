import { describe, expect, it, vi } from 'vitest';
import { persistSetupStep } from './setup-progress.js';

describe('persistSetupStep', () => {
  it('reports success only after the patch resolves', async () => {
    const patchAgent = vi.fn(async (body: { setup_step: string | null }) => body);
    await expect(persistSetupStep(patchAgent, 'context')).resolves.toEqual({ ok: true });
    expect(patchAgent).toHaveBeenCalledWith({ setup_step: 'context' });
  });

  it('surfaces a step-save failure instead of treating progress as saved', async () => {
    const patchAgent = vi.fn(async () => {
      throw new Error('network');
    });
    await expect(persistSetupStep(patchAgent, 'permissions')).resolves.toEqual({
      ok: false,
      message: 'Could not save setup progress. Try again.',
    });
  });

  it('surfaces a finish-setup failure without clearing setup_step on the client', async () => {
    const patchAgent = vi.fn(async () => {
      throw { status: 500 };
    });
    await expect(persistSetupStep(patchAgent, null)).resolves.toEqual({
      ok: false,
      message: 'Could not finish setup. Try again.',
    });
  });

  it('skips the network when there is no agent to patch', async () => {
    await expect(persistSetupStep(null, 'ready')).resolves.toEqual({ ok: true });
  });
});
