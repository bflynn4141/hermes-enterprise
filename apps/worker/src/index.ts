// The Worker.
//
// One origin serves both the API and the client bundle, which is what lets the
// session cookie be SameSite=Strict. Unknown paths fall through to the static
// assets binding with SPA fallback, so client-side routing works without a
// catch-all route here.
//
// What is real in M1: /health, /w/:ws/bootstrap, /w/:ws/events, the tenant
// transaction, the queue and cron handlers' plumbing. M3.5 filled in the
// uploads routes and the `extract` consumer; the `renders` consumer is still a
// scaffold that M4 completes.
import { Hono } from 'hono';
import type { Env } from './env.js';
import { AuthError } from './auth.js';
import { TenancyError } from './db/client.js';
import { health } from './routes/health.js';
import { bootstrap, events } from './routes/workspace.js';
import { addKey, catalog, deleteKey, listKeys, rotateKey, verifyKey } from './routes/keys.js';
import { RouteError } from './routes/tenant.js';
import { authSession, callback, login, logout } from './routes/auth.js';
import { createWorkspace } from './routes/workspaces.js';
import {
  createInvitation,
  listInvitations,
  listMembers,
  patchMember,
  removeMember,
  resendInvitation,
  withdrawInvitation,
} from './routes/members.js';
import {
  archiveSession,
  clearMessageFeedback,
  createSession,
  createShare,
  getDraft,
  getSessionRoute,
  listMessages,
  listSessions,
  patchSession,
  putDraft,
  revokeShare,
  setMessageFeedback,
} from './routes/sessions.js';
import {
  completeAttachment,
  createAttachment,
  deleteAttachment,
  getAttachment,
  uploadAttachment,
} from './routes/attachments.js';
import { completeFile, createFile, deleteFile, getFile, listFiles, uploadFile } from './routes/files.js';
import { sessionSocket, workspaceSocket } from './routes/hubs.js';
import { takeRefreshedCookie } from './auth/adapters.js';
import { drainJobs } from './jobs.js';
import { handleQueue } from './queues/index.js';
import { sweepOrphanedUploads } from './storage/lifecycle.js';
import { pollWorkOSEvents } from './auth/events-poller.js';

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
  if (error instanceof RouteError) {
    return c.json({ error: error.message, reason: error.reason }, error.status);
  }
  console.error('unhandled error', error);
  return c.json({ error: 'internal error', reason: 'internal' }, 500);
});

// A request whose session was refreshed mid-flight carries a re-sealed cookie
// back. It is attached here rather than in each route, because a route that
// forgot would leave the browser holding a session that expires again in five
// minutes, and the symptom — a refresh on every single request — is invisible
// until someone reads a log.
app.use('*', async (c, next) => {
  await next();
  const refreshed = takeRefreshedCookie(c.req.raw);
  if (refreshed) c.res.headers.append('Set-Cookie', refreshed);
});

app.get('/health', health);

// Identity. These four are the only routes that talk to AuthKit.
app.get('/auth/login', login);
app.get('/auth/callback', callback);
app.get('/auth/session', authSession);
app.post('/auth/logout', logout);
app.get('/auth/logout', logout);

// Creating a workspace is the one tenant-shaped route with no tenant in its
// path, because the tenant does not exist until it succeeds.
app.post('/workspaces', createWorkspace);
app.get('/w/:ws/bootstrap', bootstrap);
app.get('/w/:ws/events', events);

// Settings > Provider keys (Admin, step-up) and the catalog the model menu
// reads (any member). See src/routes/keys.ts for why the two differ.
app.get('/w/:ws/catalog', catalog);
app.get('/w/:ws/provider-keys', listKeys);
app.post('/w/:ws/provider-keys', addKey);
app.post('/w/:ws/provider-keys/:id/verify', verifyKey);
app.post('/w/:ws/provider-keys/:id/rotate', rotateKey);
app.delete('/w/:ws/provider-keys/:id', deleteKey);

// Sessions, and everything hanging off one.
app.get('/w/:ws/sessions', listSessions);
app.post('/w/:ws/sessions', createSession);
app.get('/w/:ws/sessions/:id', getSessionRoute);
app.patch('/w/:ws/sessions/:id', patchSession);
app.get('/w/:ws/sessions/:id/draft', getDraft);
app.put('/w/:ws/sessions/:id/draft', putDraft);
app.get('/w/:ws/sessions/:id/messages', listMessages);
app.post('/w/:ws/sessions/:id/shares', createShare);
app.delete('/w/:ws/sessions/:id/shares/:shareId', revokeShare);
app.delete('/w/:ws/sessions/:id', archiveSession);
app.put('/w/:ws/messages/:id/feedback', setMessageFeedback);
app.delete('/w/:ws/messages/:id/feedback', clearMessageFeedback);

// Uploads. The bytes go from the browser to R2 through a presigned PUT, so
// `complete` is where the file is checked: sniffed against its declared type,
// hashed, and only then enqueued for extraction. `files` is the same path for
// the agent's Context sources (`agent_files`).
app.post('/w/:ws/attachments', createAttachment);
app.put('/w/:ws/attachments/:id/upload', uploadAttachment);
app.post('/w/:ws/attachments/:id/complete', completeAttachment);
app.get('/w/:ws/attachments/:id', getAttachment);
app.delete('/w/:ws/attachments/:id', deleteAttachment);

app.get('/w/:ws/files', listFiles);
app.post('/w/:ws/files', createFile);
app.put('/w/:ws/files/:id/upload', uploadFile);
app.post('/w/:ws/files/:id/complete', completeFile);
app.get('/w/:ws/files/:id', getFile);
app.delete('/w/:ws/files/:id', deleteFile);

// Members and invitations. WorkOS sends the email; `members` decides access.
app.get('/w/:ws/members', listMembers);
app.get('/w/:ws/invitations', listInvitations);
app.patch('/w/:ws/members/:id', patchMember);
app.delete('/w/:ws/members/:id', removeMember);
app.post('/w/:ws/invitations', createInvitation);
app.post('/w/:ws/invitations/:id/resend', resendInvitation);
app.post('/w/:ws/invitations/:id/withdraw', withdrawInvitation);

// The two socket upgrades. Authorisation happens here; the hub only holds the
// result and honours its expiry.
app.get('/w/:ws/hub/workspace', workspaceSocket);
app.get('/w/:ws/hub/session/:id', sessionSocket);

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
    if (event.cron !== '* * * * *') {
      // The nightly validator is a Workflow (M5a): a Cron handler caps at 15
      // minutes and a full run-log validation does not.
      console.log(JSON.stringify({ at: 'scheduled', cron: event.cron, note: 'validator lands in M5a' }));
      // The R2 lifecycle rule the plan names: objects with no completed
      // attachments row after 24 hours. Best-effort and bounded, because this
      // handler has 30 seconds of CPU and an orphan costing one more day of
      // storage is not an incident.
      ctx.waitUntil(
        sweepOrphanedUploads(env).catch((error) =>
          console.log(JSON.stringify({ at: 'cron.uploads', ok: false, error: String(error) })),
        ),
      );
      return;
    }
    // Both halves are best-effort and independent: a WorkOS outage must not
    // stop the jobs drain, and a slow job must not stop the poller, because the
    // next minute runs both again from where they stopped.
    ctx.waitUntil(
      (async () => {
        try {
          const drained = await drainJobs(env);
          console.log(JSON.stringify({ at: 'cron.jobs', ...drained }));
        } catch (error) {
          console.log(JSON.stringify({ at: 'cron.jobs', ok: false, error: String(error) }));
        }
        try {
          const polled = await pollWorkOSEvents(env);
          console.log(JSON.stringify({ at: 'cron.workos', ...polled }));
        } catch (error) {
          console.log(JSON.stringify({ at: 'cron.workos', ok: false, error: String(error) }));
        }
        // The orphan sweep: runs that claim to be working with no event for ten
        // minutes. M2 can only see the row; comparing it with the Workflow
        // instance's own status is M3, so nothing is marked errored yet and the
        // count is logged instead of acted on.
        console.log(JSON.stringify({ at: 'cron.orphans', note: 'instance status check lands in M3' }));
      })(),
    );
  },

  /**
   * Queue consumers. Both queues have a dead-letter queue: without one,
   * messages that exhaust their retries are deleted, and a silently dropped
   * extraction becomes a document the reviewer cannot read with no reason
   * shown. The DLQ consumer writes the failure onto the row instead.
   */
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    void ctx;
    console.log(JSON.stringify({ at: 'queue', queue: batch.queue, messages: batch.messages.length }));
    // Routed by queue name, because one handler serves all four (see
    // src/queues/index.ts). A queue this build does not know about is retried,
    // never acked: an unknown queue means a deploy is behind, and acking would
    // delete the messages it is behind on.
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;
