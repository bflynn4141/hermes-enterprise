// GET /w/:ws/usage?range=
//
// Any member may read it. That is a deliberate choice rather than an oversight:
// the numbers here are what the workspace's own agent spent on the workspace's
// own key, a Member can already see every run that produced them, and a spend
// figure only one person can see is a spend figure nobody checks. What a Member
// cannot do is *change* the caps — that is the Admin-only PATCH in settings.ts.
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
  const report = await inWorkspace(c, (work) => usageReport(work.tx, work.workspaceId, range));
  return c.json(report);
}
