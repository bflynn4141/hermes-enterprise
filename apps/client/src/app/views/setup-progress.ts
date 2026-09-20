/**
 * Write `agents.setup_step` before the UI claims the step advanced. A silent
 * `.catch(() => undefined)` used to let Continue / Start navigate even when
 * the patch failed, so leaving and returning looked further along than the
 * server had stored.
 */
export type SetupPersistResult = { ok: true } | { ok: false; message: string };

export async function persistSetupStep(
  patchAgent: ((body: { setup_step: string | null }) => Promise<unknown>) | null,
  next: string | null,
): Promise<SetupPersistResult> {
  if (!patchAgent) return { ok: true };
  try {
    await patchAgent({ setup_step: next });
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: next === null
        ? 'Could not finish setup. Try again.'
        : 'Could not save setup progress. Try again.',
    };
  }
}
