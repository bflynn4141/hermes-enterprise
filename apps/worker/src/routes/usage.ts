// GET /w/:ws/usage?range=
//
// Admin-only. The report includes workspace-wide session titles and provider
// key attribution. Agents and sessions are now per-member, so workspace
// membership no longer implies visibility of every row behind these totals.
//
// Every number in the response is shipped with `disclaimer`, and the client is
// expected to render it beside the total rather than in a footnote. See
// `src/usage/aggregate.ts` for why that sentence is the server's to write.
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { parseRange, usageReport } from '../usage/aggregate.js';
import { inWorkspace } from './tenant.js';

export async function getUsage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const range = parseRange(c.req.query('range'));
  const report = await inWorkspace(c, (work) => {
    work.requireAdmin('viewing workspace usage');
    return usageReport(work.tx, work.workspaceId, range);
  });
  return c.json(report);
}
