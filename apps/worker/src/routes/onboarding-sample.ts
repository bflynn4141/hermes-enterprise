// The first-run Partner Program walkthrough.
//
// It is intentionally independent of provider credentials and intake systems:
// the server advances a deterministic, clearly disclosed simulation over nine
// eleven seconds. The records and cursor are durable, so reload/reconnect resumes the
// same attempt rather than playing a client-side animation from the beginning.
import type { Context } from 'hono';
import {
  onboardingSampleSnapshotSchema,
  onboardingSampleStartInputSchema,
  streamIdSchema,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin } from '../auth.js';
import { samplePartnerSnapshot, startSamplePartnerRun } from '../onboarding/sample-partner-runs.js';
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';

function cursor(c: Context<{ Bindings: Env }>): string {
  const parsed = streamIdSchema.safeParse(c.req.query('after') ?? '0');
  if (!parsed.success) throw new RouteError('after is not a sample event cursor', 'bad_cursor', 400);
  return parsed.data;
}

/** POST /w/:ws/onboarding/sample-runs */
export async function startOnboardingSample(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const parsed = onboardingSampleStartInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('agent_id and setup_attempt_id must be UUIDs', 'bad_sample_run', 422);

  const result = await inWorkspace(c, async (work) => {
    const started = await startSamplePartnerRun(work, parsed.data.agent_id, parsed.data.setup_attempt_id);
    const snapshot = await samplePartnerSnapshot(work, started.runId, '0');
    return { ...started, snapshot };
  });
  return c.json(onboardingSampleSnapshotSchema.parse(result.snapshot), result.created ? 201 : 200, {
    'X-Hermes-Idempotent-Replay': result.created ? 'false' : 'true',
  });
}

/** GET /w/:ws/onboarding/sample-runs/:id?after=<cursor> */
export async function getOnboardingSample(c: Context<{ Bindings: Env }>): Promise<Response> {
  const runId = pathUuid(c, 'id');
  const after = cursor(c);
  const snapshot = await inWorkspace(c, (work) => samplePartnerSnapshot(work, runId, after));
  return c.json(onboardingSampleSnapshotSchema.parse(snapshot));
}
