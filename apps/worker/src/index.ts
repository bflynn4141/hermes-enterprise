// The Worker.
//
// One origin serves both the API and the client bundle, which is what lets the
// session cookie be SameSite=Strict. Unknown paths fall through to the static
// assets binding with SPA fallback, so client-side routing works without a
// catch-all route here.
//
// What is real in M1: /health, /w/:ws/bootstrap, /w/:ws/events, the tenant
// transaction, the queue and cron handlers' plumbing. What is stubbed: the run
// engine (M3), WorkOS auth (M2), and every consumer body.
import { Hono } from 'hono';
import type { Env } from './env.js';
import { AuthError } from './auth.js';
import { TenancyError } from './db/client.js';
import { health } from './routes/health.js';
import { bootstrap, events } from './routes/workspace.js';

export { SessionHub, WorkspaceHub } from './hubs.js';
export { RunAttempt } from './runs/workflow.js';

const app = new Hono<{ Bindings: Env }>();

// Errors carry a machine-readable `reason`, because the client keys its copy
// off it: "Signed out", "Reconnecting", "Admin decision required" are different
// screens, and a string comparison on a message is not a contract.
app.onError((error, c) => {
  if (error instanceof AuthError) {
    return c.json({ error: error.message, reason: error.reason }, error.status);
  }
  if (error instanceof TenancyError) {
    // A non-member is told the workspace does not exist. Whether it exists is
    // itself something a non-member should not learn.
    const status = error.reason === 'not_a_member' ? 404 : 400;
    return c.json({ error: 'workspace not found', reason: error.reason }, status);
  }
  console.error('unhandled error', error);
  return c.json({ error: 'internal error', reason: 'internal' }, 500);
});

app.get('/health', health);
app.get('/w/:ws/bootstrap', bootstrap);
app.get('/w/:ws/events', events);

// Anything else under /api or /w that did not match is a 404 as JSON, not the
// SPA shell: a client that asked for data should not be handed HTML.
app.all('/w/*', (c) => c.json({ error: 'not found', reason: 'unknown_route' }, 404));
app.all('/api/*', (c) => c.json({ error: 'not found', reason: 'unknown_route' }, 404));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /**
   * Two schedules (see wrangler.jsonc):
   *   every minute  drain `jobs`, sweep orphaned runs, poll the WorkOS Events
   *                 API. Cron handlers get 30 s of CPU at sub-hour intervals.
   *   nightly       kick off the validator Workflow, which pages through runs
   *                 one step per 200, because a Cron handler caps at 15 minutes
   *                 and the validator does not.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    void env;
    void ctx;
    console.log(JSON.stringify({ at: 'scheduled', cron: event.cron, note: 'handlers land in M2 and M4' }));
  },

  /**
   * Queue consumers. Both queues have a dead-letter queue: without one,
   * messages that exhaust their retries are deleted, and a silently dropped
   * extraction becomes a document the reviewer cannot read with no reason
   * shown. The DLQ consumer writes the failure onto the row instead.
   */
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    void env;
    void ctx;
    console.log(JSON.stringify({ at: 'queue', queue: batch.queue, messages: batch.messages.length }));
    // Nothing is acknowledged yet: retrying a message the consumer never
    // handled is correct, and a silent ack would lose it.
    batch.retryAll();
  },
} satisfies ExportedHandler<Env>;
