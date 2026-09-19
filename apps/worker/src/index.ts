// The Worker.
//
// One origin serves both the API and the client bundle, which is what lets the
// session cookie be SameSite=Strict. Unknown paths fall through to the static
// assets binding with SPA fallback, so client-side routing works without a
// catch-all route here.
//
// What is real in M1: /health, /w/:ws/bootstrap, /w/:ws/events, the tenant
// transaction, the queue and cron handlers' plumbing. M3.5 filled in the
// uploads routes and the `extract` consumer; M4 filled in the decision route,
// the effects ledger, History, the Library and the `renders` consumer.
import { Hono } from 'hono';
import { withSentry } from '@sentry/cloudflare';
import type { Env } from './env.js';
import { AuthError } from './auth.js';
import { TenancyError } from './db/client.js';
import { health } from './routes/health.js';
import { authorizeAgentCashContact, authorizeAgentCashCreatorSearch, authorizeAgentCashPeopleSearch, importAgentCashContact, importAgentCashCreatorSearch, importAgentCashPeopleSearch, pendingAgentCashContacts, pendingAgentCashCreatorSearch, pendingAgentCashPeopleSearch, listRuntimeSkills, listRuntimeTools, callRuntimeTool, runtimeModels, runtimeChatCompletions } from './runtime/bridge.js';
import { bootstrap, events } from './routes/workspace.js';
import { addKey, catalog, deleteKey, listKeys, rotateKey, verifyKey } from './routes/keys.js';
import { pollNousOAuth, startNousOAuth } from './routes/provider-oauth.js';
import { getOutboundEmailConnection, gmailOAuthCallback, startGmailOAuth } from './routes/outbound-email.js';
import { RouteError } from './routes/tenant.js';
import { authSession, callback, login, logout } from './routes/auth.js';
import { createWorkspace } from './routes/workspaces.js';
import { acceptInvitation } from './routes/invitations.js';
import { getTrace, listTraces } from './routes/traces.js';
import {
  acceptInstruction,
  adoptSkill,
  discardInstruction,
  listContextFields,
  listInstructions,
  listSkills,
  patchContextField,
} from './routes/agent-config.js';
import { getSkillAssignment, listSkillAssignments, patchSkillAssignment } from './routes/skill-assignments.js';
import { appShellOrUnknownRoute } from './routes/spa.js';
import { sharedSession } from './routes/shares.js';
import { KeyCryptoError } from './keys/envelope.js';
import { redactMessage } from './keys/redact.js';
import { KeyStoreError } from './keys/store.js';
import {
  createInvitation,
  listInvitations,
  listMembers,
  patchMember,
  removeMember,
  resendInvitation,
  withdrawInvitation,
} from './routes/members.js';
import { registerHermesCapacity } from './routes/hermes-capacity.js';
import {
  archiveSession,
  clearMessageFeedback,
  createSession,
  createShare,
  getDraft,
  getSessionRoute,
  getSessionSnapshot,
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
import {
  answerContext,
  createTurn,
  editQueueItem,
  getRunRoute,
  guideRun,
  queueMessage,
  removeQueueItem,
  retryRun,
  stopRun,
} from './routes/turns.js';
import { createDecision } from './routes/decisions.js';
import {
  createApprovalDecision,
  createApprovalRevision,
  createApprovalRoute,
  getApprovalRoute,
  getApprovalEvidenceRoute,
} from './routes/approvals.js';
import {
  createRequestNote,
  getRequest,
  listRequestDocuments,
  listRequestEffects,
  listRequests,
} from './routes/requests.js';
import { executeEffect, listEffects } from './routes/effects.js';
import { eraseApplicant, historyCounts, listHistory } from './routes/history.js';
import {
  createDocumentVersion,
  getDocument,
  getDocumentRender,
  listDocumentVersions,
  listDocuments,
} from './routes/documents.js';
import { getUsage } from './routes/usage.js';
import {
  deleteWorkspace,
  getDataPrivacy,
  getSettings,
  patchAttestation,
  patchSettings,
  undeleteWorkspace,
} from './routes/settings.js';
import { sentryOptions } from './ops/sentry.js';
import { sweepPlatformCounters } from './ops/instance-cap.js';
import { runNightly } from './ops/nightly.js';
import { sweepRuns } from './runs/sweep.js';
import { getAgentRecovery, wakeAgent } from './routes/recovery.js';
import { scheduleRunRecovery } from './runs/recovery.js';
import { sessionSocket, workspaceSocket } from './routes/hubs.js';
import { takeRefreshedCookie } from './auth/adapters.js';
import { drainJobs, withWorkspaceTransaction } from './jobs.js';
import { enqueueAutomatedPartnerScreening } from './partner-screening/automation.js';
import { PLATFORM_WORKSPACE_ID } from './auth/rate-limit.js';
import { handleQueue } from './queues/index.js';
import { sweepOrphanedUploads } from './storage/lifecycle.js';
import { pollWorkOSEvents } from './auth/events-poller.js';
import {
  disconnectSlack,
  createSlackLinkCode,
  getSlackConnection,
  slackOAuthCallback,
  startSlackOAuth,
} from './routes/slack.js';
import { slackEvents } from './routes/slack-events.js';
import {
  getPartnerScreening,
  handoffPartnerScreening,
  partnerScreeningSources,
  startPartnerScreening,
} from './routes/partner-screening.js';
import { getAgentProvisioning, patchAgent, verifyAgentProvisioning } from './routes/agents.js';
import {
  configurePartnerWorkflowRoute,
  correctPartnerInvoice,
  createPartnerInvoiceIntake,
  createPartnerInvoiceReviewHandoff,
  getPartnerHandoffResultRoute,
  getPartnerWorkflow,
  proposePartnerEngagement,
  setPartnerWorkflowAdmission,
} from './routes/partner-workflow.js';

export { SessionHub, WorkspaceHub } from './hubs.js';
export { RunAttempt } from './runs/workflow.js';
// The three long-wait Workflows (M5a). Registered in wrangler.jsonc; the bodies
// are plain functions in src/workflows-long/ so they can be tested in Node.
export { KekRotation, NightlyValidator, WorkspaceDeletion } from './workflows-long/index.js';

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
  // Envelope encryption. A missing or malformed `KEK_V{n}` is a *configuration*
  // failure, not a bug in the request: the deployment cannot encrypt anything
  // until someone sets the secret, and `.dev.vars.example` ships `KEK_V1=""`,
  // so a fresh checkout hits it on the first provider key it adds. 503 with a
  // reason the client can render beats 500 `internal`, which sent a person
  // looking for a bug that is not there. A decrypt failure is different — the
  // key material is there and did not authenticate — and stays a 500.
  if (error instanceof KeyCryptoError) {
    if (error.reason === 'kek_missing' || error.reason === 'kek_version_unknown' || error.reason === 'kek_malformed') {
      return c.json({ error: error.message, reason: 'kek_unavailable' }, 503);
    }
    if (error.reason === 'plaintext_empty') {
      return c.json({ error: error.message, reason: error.reason }, 422);
    }
  }
  // The key store's own conditions. `already_revoked` is the one a person
  // reaches by double-clicking Remove, and 409 is what says "that already
  // happened" rather than "something broke".
  if (error instanceof KeyStoreError) {
    const status =
      error.reason === 'already_revoked'
        ? 409
        : error.reason === 'duplicate_key'
          ? 409
          : error.reason === 'not_found'
            ? 404
            : error.reason === 'unknown_provider'
              ? 422
              : 409;
    return c.json({ error: error.message, reason: error.reason }, status);
  }
  // Any other domain error that names its own status. A thrown error carrying
  // `status` and `reason` has already decided how it should be answered, and
  // mapping it to 500 here would lose that on the way out — which is the
  // failure this whole block exists to stop: a known condition reported as an
  // unknown one. See decision F5.
  //
  // Narrowed to real `Error` instances (security review O21). Matching on shape
  // alone meant anything thrown with a `status` and a `reason` chose its own
  // status code and had its `message` returned to the caller — and the things
  // most likely to have those two fields are objects that came *from* an
  // upstream: a parsed provider error body, a decoded JSON payload. A thrown
  // plain object is a bug, and a bug is a 500.
  const carried = error as { status?: unknown; reason?: unknown; message?: string };
  if (
    error instanceof Error &&
    typeof carried.status === 'number' &&
    carried.status >= 400 &&
    carried.status <= 599 &&
    typeof carried.reason === 'string'
  ) {
    return c.json(
      { error: carried.message ?? 'request failed', reason: carried.reason },
      carried.status as 400,
    );
  }
  // Redacted, because this is the catch-all for every route including the four
  // that carry provider key material, and it was the one error sink in the
  // Worker that logged a raw message (security review O22). `redactMessage`
  // knows the key shapes and the secret names; the stack is dropped entirely,
  // since a stack from a key route is the one place a value can appear as an
  // argument.
  console.error(JSON.stringify({ at: 'unhandled', error: redactMessage(error) }));
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
// Server-to-server profile credentials; these routes never accept browser auth.
app.get('/internal/runtime/w/:ws/agents/:agentId/tools', listRuntimeTools);
app.get('/internal/runtime/w/:ws/agents/:agentId/skills', listRuntimeSkills);
app.post('/internal/runtime/w/:ws/agents/:agentId/calls', callRuntimeTool);
app.post('/internal/runtime/w/:ws/agents/:agentId/agentcash/people-search/authorize', authorizeAgentCashPeopleSearch);
app.get('/internal/runtime/w/:ws/agents/:agentId/agentcash/people-search/pending', pendingAgentCashPeopleSearch);
app.post('/internal/runtime/w/:ws/agents/:agentId/agentcash/people-search/import', importAgentCashPeopleSearch);
app.post('/internal/runtime/w/:ws/agents/:agentId/agentcash/creator-search/authorize', authorizeAgentCashCreatorSearch);
app.get('/internal/runtime/w/:ws/agents/:agentId/agentcash/creator-search/pending', pendingAgentCashCreatorSearch);
app.post('/internal/runtime/w/:ws/agents/:agentId/agentcash/creator-search/import', importAgentCashCreatorSearch);
app.post('/internal/runtime/w/:ws/agents/:agentId/agentcash/contact/authorize', authorizeAgentCashContact);
app.get('/internal/runtime/w/:ws/agents/:agentId/agentcash/contact/pending', pendingAgentCashContacts);
app.post('/internal/runtime/w/:ws/agents/:agentId/agentcash/contact/import', importAgentCashContact);
app.get('/internal/runtime/w/:ws/agents/:agentId/model/v1/models', runtimeModels);
app.post('/internal/runtime/w/:ws/agents/:agentId/model/v1/chat/completions', runtimeChatCompletions);

// Identity. These four are the only routes that talk to AuthKit.
app.get('/auth/login', login);
app.get('/auth/callback', callback);
app.get('/auth/session', authSession);
app.post('/auth/logout', logout);
app.get('/auth/logout', logout);

// Creating a workspace is the one tenant-shaped route with no tenant in its
// path, because the tenant does not exist until it succeeds.
app.post('/workspaces', createWorkspace);
// Accepting an invitation is the other one: the workspace is what the call is
// trying to reach, so it cannot be the key the call is authorised under.
app.post('/invitations/:token/accept', acceptInvitation);
// Slack calls these two routes without a Hermes browser session. The callback
// is bound to a short-lived, single-use signed state row; Events API requests
// are verified against the raw request bytes before JSON parsing.
app.get('/integrations/slack/oauth/callback', slackOAuthCallback);
app.get('/integrations/gmail/oauth/callback', gmailOAuthCallback);
app.post('/integrations/slack/events', slackEvents);
// Redeeming a share link. Unauthenticated by design — the token *is* the
// authorisation — and the only route in the system that answers without a
// session. It grants one session, read-only, up to the share's cutoff. See
// src/routes/shares.ts and decision G1.
app.get('/shared/:token', sharedSession);
app.get('/w/:ws/bootstrap', bootstrap);
app.get('/w/:ws/events', events);
app.patch('/w/:ws/agents/:agentId', patchAgent);
app.get('/w/:ws/agents/:agentId/provisioning', getAgentProvisioning);
app.post('/w/:ws/agents/:agentId/provisioning/verify', verifyAgentProvisioning);

// Live public-source ingestion persists evidence before Iris sees it. The
// explicit handoff starts the bound agent against those read-only artifacts;
// any resulting application remains pending for a human in Inbox.
app.get('/w/:ws/partner-screening/agents/:agentId/sources', partnerScreeningSources);
app.post('/w/:ws/partner-screening/runs', startPartnerScreening);
app.get('/w/:ws/partner-screening/runs/:id', getPartnerScreening);
app.post('/w/:ws/partner-screening/runs/:id/handoff', handoffPartnerScreening);

// Settings > Provider keys (Admin; mutations require step-up) and the catalog
// the model menu reads (any member). See src/routes/keys.ts for the boundary.
app.get('/w/:ws/catalog', catalog);
app.get('/w/:ws/provider-keys', listKeys);
app.post('/w/:ws/provider-keys', addKey);
app.post('/w/:ws/provider-keys/:id/verify', verifyKey);
app.post('/w/:ws/provider-keys/:id/rotate', rotateKey);
app.delete('/w/:ws/provider-keys/:id', deleteKey);
app.get('/w/:ws/integrations/slack', getSlackConnection);
app.post('/w/:ws/integrations/slack/oauth/start', startSlackOAuth);
app.post('/w/:ws/integrations/slack/link-code', createSlackLinkCode);
app.delete('/w/:ws/integrations/slack', disconnectSlack);
app.get('/w/:ws/integrations/email', getOutboundEmailConnection);
app.post('/w/:ws/integrations/email/gmail/oauth/start', startGmailOAuth);
app.post('/w/:ws/provider-connections/nous/start', startNousOAuth);
app.post('/w/:ws/provider-connections/nous/:id/poll', pollNousOAuth);

// Sessions, and everything hanging off one.
app.get('/w/:ws/sessions', listSessions);
app.post('/w/:ws/sessions', createSession);
app.get('/w/:ws/sessions/:id', getSessionRoute);
app.get('/w/:ws/sessions/:id/snapshot', getSessionSnapshot);
app.patch('/w/:ws/sessions/:id', patchSession);
app.get('/w/:ws/sessions/:id/draft', getDraft);
app.put('/w/:ws/sessions/:id/draft', putDraft);
app.get('/w/:ws/sessions/:id/messages', listMessages);
app.post('/w/:ws/sessions/:id/shares', createShare);
app.delete('/w/:ws/sessions/:id/shares/:shareId', revokeShare);
app.delete('/w/:ws/sessions/:id', archiveSession);
app.put('/w/:ws/messages/:id/feedback', setMessageFeedback);
app.delete('/w/:ws/messages/:id/feedback', clearMessageFeedback);

// Turns and the four controls. `client_turn_id` is the idempotency key: the
// `runs` row is inserted under UNIQUE(session_id, client_turn_id) before the
// Workflow instance is created, because `create()` throws on a duplicate id and
// only `createBatch()` is idempotent.
app.post('/w/:ws/sessions/:id/turns', createTurn);
app.get('/w/:ws/sessions/:id/runs/:runId', getRunRoute);
app.post('/w/:ws/sessions/:id/runs/:runId/stop', stopRun);
app.post('/w/:ws/sessions/:id/runs/:runId/guide', guideRun);
app.post('/w/:ws/sessions/:id/runs/:runId/retry', retryRun);
app.get('/w/:ws/agents/:agentId/recovery', getAgentRecovery);
app.post('/w/:ws/agents/:agentId/wake', wakeAgent);
app.post('/w/:ws/sessions/:id/runs/:runId/queue', queueMessage);
app.patch('/w/:ws/sessions/:id/runs/:runId/queue/:itemId', editQueueItem);
app.delete('/w/:ws/sessions/:id/runs/:runId/queue/:itemId', removeQueueItem);
app.post('/w/:ws/sessions/:id/runs/:runId/context', answerContext);

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

// The Inbox, the decision, the effects ledger, History and the Library.
//
// `POST /w/:ws/requests/:id/decisions` is the only route in this table that
// moves a request out of `pending`, and it is the only writer of `decisions`.
// Five guards in front of it (see src/routes/decisions.ts) and one transaction
// behind it (src/domain/decisions.ts).
app.get('/w/:ws/requests', listRequests);
app.get('/w/:ws/requests/:id', getRequest);
app.post('/w/:ws/requests/:id/decisions', createDecision);
app.get('/w/:ws/requests/:id/approval', getApprovalRoute);
app.get('/w/:ws/requests/:id/approval/evidence/:evidenceId', getApprovalEvidenceRoute);
app.post('/w/:ws/requests/:id/approval/decisions', createApprovalDecision);
app.post('/w/:ws/requests/:id/approval/revisions', createApprovalRevision);
app.post('/w/:ws/requests/:id/approval/route', createApprovalRoute);
app.post('/w/:ws/requests/:id/notes', createRequestNote);
app.get('/w/:ws/requests/:id/effects', listRequestEffects);
app.get('/w/:ws/requests/:id/documents', listRequestDocuments);

// Effects are recorded by a decision and executed by nobody: every execution
// answers `unavailable`, because this build sends, pays, grants and signs
// nothing (CONVENTIONS, invariant 5).
app.get('/w/:ws/effects', listEffects);
app.post('/w/:ws/effects/:id/execute', executeEffect);

// History is rendered at read time from ids, which is what lets an erasure
// tombstone a subject and leave the audit trail standing.
app.get('/w/:ws/history', listHistory);
app.get('/w/:ws/history/counts', historyCounts);
app.delete('/w/:ws/applicants/:subject_key', eraseApplicant);

// The Library. A new version after a decision is a guarded human command: it
// cancels the pending effects and re-renders, and a tool cannot reach it (the
// trigger in migration 0005 refuses the agent role outright).
app.get('/w/:ws/documents', listDocuments);
app.get('/w/:ws/documents/:id', getDocument);
app.get('/w/:ws/documents/:id/versions', listDocumentVersions);
app.post('/w/:ws/documents/:id/versions', createDocumentVersion);
app.get('/w/:ws/documents/:id/render', getDocumentRender);

// Usage and settings. Usage is readable by any member — they can already see
// every run that produced the numbers — and the caps that govern it are
// Admin-only to change. `DELETE /w/:ws` revokes access now and schedules the
// destruction for seven days from now (src/workflows-long/workspace-deletion.ts).
app.get('/w/:ws/usage', getUsage);
app.get('/w/:ws/settings', getSettings);
app.patch('/w/:ws/settings', patchSettings);
app.get('/w/:ws/settings/data-privacy', getDataPrivacy);
app.post('/w/:ws/settings/undelete', undeleteWorkspace);
app.patch('/w/:ws/provider-keys/:id/attestation', patchAttestation);
app.delete('/w/:ws', deleteWorkspace);

// Members and invitations. WorkOS sends the email; `members` decides access.
app.get('/w/:ws/members', listMembers);
app.get('/w/:ws/invitations', listInvitations);
app.patch('/w/:ws/members/:id', patchMember);
app.delete('/w/:ws/members/:id', removeMember);
app.post('/w/:ws/invitations', createInvitation);
app.post('/w/:ws/invitations/:id/resend', resendInvitation);
app.post('/w/:ws/invitations/:id/withdraw', withdrawInvitation);
app.post('/w/:ws/admin/hermes-capacity', registerHermesCapacity);

// The Agent tab's own surfaces: the runs a person can read back, the skills the
// agent has adopted, its instruction versions, and the context fields a human
// answers. Every one is `inWorkspace` like the rest; none of them is new
// authority over anything (see src/routes/traces.ts).
app.get('/w/:ws/traces', listTraces);
app.get('/w/:ws/traces/:runId', getTrace);
app.get('/w/:ws/skills', listSkills);
app.post('/w/:ws/skills', adoptSkill);
app.post('/w/:ws/skills/:id/adopt', adoptSkill);
app.get('/w/:ws/agents/:agentId/skill-assignments', listSkillAssignments);
app.get('/w/:ws/agents/:agentId/skill-assignments/:id', getSkillAssignment);
app.patch('/w/:ws/agents/:agentId/skill-assignments/:id', patchSkillAssignment);
app.get('/w/:ws/partner-workflow', getPartnerWorkflow);
app.post('/w/:ws/partner-workflow/configure', configurePartnerWorkflowRoute);
app.post('/w/:ws/partner-workflow/invoice-review-handoffs', createPartnerInvoiceReviewHandoff);
app.post('/w/:ws/partner-workflow/engagement-authorizations', proposePartnerEngagement);
app.post('/w/:ws/partner-workflow/invoice-intakes', createPartnerInvoiceIntake);
app.get('/w/:ws/partner-workflow/handoffs/:handoffId/result', getPartnerHandoffResultRoute);
app.post('/w/:ws/partner-workflow/handoffs/:handoffId/corrections', correctPartnerInvoice);
app.post('/w/:ws/partner-workflow/admission', setPartnerWorkflowAdmission);
app.get('/w/:ws/instructions', listInstructions);
app.post('/w/:ws/instructions/:id/accept', acceptInstruction);
app.post('/w/:ws/instructions/:id/save', acceptInstruction);
app.post('/w/:ws/instructions/:id/discard', discardInstruction);
app.delete('/w/:ws/instructions/:id', discardInstruction);
app.get('/w/:ws/context-fields', listContextFields);
app.patch('/w/:ws/context-fields/:field', patchContextField);

// The two socket upgrades. Authorisation happens here; the hub only holds the
// result and honours its expiry.
app.get('/w/:ws/hub/workspace', workspaceSocket);
app.get('/w/:ws/hub/session/:id', sessionSocket);

// Anything that did not match is one of two things, and the request says which.
//
// A `fetch()` for data gets `{"reason":"unknown_route"}` as JSON, because a
// client that asked for data should not be handed HTML. A *browser navigation*
// gets the client bundle from the assets binding, because `/w/:ws/inbox` is a
// deep link into the app and answering it with JSON is how the shell ended up
// at `/workspace/:ws` (decision C12). `run_worker_first` puts every one of
// those paths in front of the assets binding, so this is the only place that
// can tell the two apart. See src/routes/spa.ts and decision F1.
app.all('*', appShellOrUnknownRoute);

const handler = {
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
      // The nightly validator is a Workflow: a Cron handler caps at 15 minutes
      // and a full run-log validation does not. The instance id carries the
      // date, so two Cron firings on the same night are one instance —
      // `create()` throws on a duplicate id, which is treated as a no-op
      // exactly as the turns route treats it.
      const night = new Date(event.scheduledTime).toISOString().slice(0, 10);
      ctx.waitUntil(
        (async () => {
          try {
            await env.NIGHTLY_VALIDATOR?.create({ id: `validator-${night}`, params: {} });
            console.log(JSON.stringify({ at: 'cron.validator', ok: true, night }));
          } catch (error) {
            const message = String(error);
            const duplicate = /already exists|duplicate|instance.*id/i.test(message);
            console.log(JSON.stringify({ at: 'cron.validator', ok: duplicate, night, error: message }));
          }
          // The instance-cap buckets, which would otherwise grow one row an
          // hour forever: slow enough that nobody notices and permanent enough
          // that somebody eventually does.
          try {
            const swept = await withWorkspaceTransaction(env, PLATFORM_WORKSPACE_ID, (tx) =>
              sweepPlatformCounters(tx),
            );
            console.log(JSON.stringify({ at: 'cron.counters', swept }));
          } catch (error) {
            console.log(JSON.stringify({ at: 'cron.counters', ok: false, error: String(error) }));
          }
          // The night's per-workspace work: the uploads backup, Monday's audit
          // CSV and provider-key re-verification, and yesterday's spend metric.
          // Effects become `jobs` rows rather than work done here, because this
          // handler has 30 seconds of CPU (src/ops/nightly.ts).
          try {
            const queued = await runNightly(env, new Date(event.scheduledTime));
            console.log(JSON.stringify({ at: 'cron.nightly.queued', ...queued }));
          } catch (error) {
            console.log(JSON.stringify({ at: 'cron.nightly.queued', ok: false, error: String(error) }));
          }
        })(),
      );
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
        // The orphan sweep, plus the two `app`-role halves of things the run
        // engine cannot do itself: marking a key invalid after a 401 and
        // draining a session's queue once its run finished (decision 41).
        try {
          const swept = await sweepRuns(env);
          console.log(JSON.stringify({ at: 'cron.orphans', ...swept }));
        } catch (error) {
          console.log(JSON.stringify({ at: 'cron.orphans', ok: false, error: String(error) }));
        }
        // Admission is separate from draining: the same minute may enqueue a
        // job after this pass, and the next minute will claim it. The durable
        // idempotency key makes overlapping Cron invocations harmless.
        try {
          const recovered = await scheduleRunRecovery(env);
          console.log(JSON.stringify({ at: 'cron.run_recovery', ...recovered }));
        } catch (error) {
          console.log(JSON.stringify({ at: 'cron.run_recovery', ok: false, error: String(error) }));
        }
        try {
          const automated = await enqueueAutomatedPartnerScreening(env, new Date(event.scheduledTime));
          console.log(JSON.stringify({ at: 'cron.partner_screening', ...automated }));
        } catch (error) {
          console.log(JSON.stringify({ at: 'cron.partner_screening', ok: false, error: String(error) }));
        }
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

/**
 * Sentry wraps the handler, always, and does nothing without a DSN.
 *
 * `sentryOptions` returns `undefined` when `SENTRY_DSN` is unset, which is the
 * documented way to disable the SDK — so `wrangler dev --local`, every test and
 * any environment that has not been handed a DSN run the same code path as
 * production with the tracker switched off. There is no second export and no
 * conditional import: a build where observability is a different bundle is a
 * build whose production behaviour nobody exercised.
 *
 * What it reports is trimmed to ids: no cookies, no bodies, no headers, and the
 * user id alone. See src/ops/sentry.ts for why each of those is a decision.
 */
export default withSentry(sentryOptions, handler);
