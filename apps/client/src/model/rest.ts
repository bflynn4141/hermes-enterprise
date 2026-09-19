// The typed REST client. One `request<T>` does the whole policy; everything
// below it is a route table (client-port spec §5.1).
//
// Policy, in one place so no call site can forget a piece of it:
//   * `credentials: 'include'` always, plus the auth adapter's headers;
//   * every response is parsed with a zod schema from `packages/shared` — an
//     unparsed body never reaches the reducer (CONVENTIONS, apps/client);
//   * unsafe methods carry the `hermes_csrf` double-submit token as
//     `X-CSRF-Token`;
//   * idempotent GETs retry twice on 502/503 honouring `Retry-After`; a POST is
//     never retried, because a retried POST is a second turn;
//   * an error carries the server's machine-readable `reason`, which is what
//     the copy keys off — a string comparison on a message is not a contract.
import {
  bootstrapSchema,
  contextNoteSchema,
  agentPermissionsSchema,
  approvalEvidenceViewSchema,
  type ApprovalEvidenceView,
  agentRecoveryViewSchema,
  agentProvisioningResponseSchema,
  catalogPageSchema,
  errorBodySchema,
  eventsPageSchema,
  healthSchema,
  providerKeyListSchema,
  providerKeyMutationSchema,
  providerKeyRemovedSchema,
  providerKeyVerifySchema,
  slackConnectionSchema,
  slackDisconnectSchema,
  slackLinkCodeSchema,
  slackOAuthStartSchema,
  outboundEmailConnectionSchema,
  outboundEmailOAuthStartSchema,
  providerOAuthStartSchema,
  providerOAuthPollSchema,
  runViewSchema,
  sessionSnapshotSchema,
  type SessionSettings,
  guidanceAcceptedSchema,
  queueStateSchema,
  attachmentSchema,
  attachmentDetailSchema,
  attachmentUploadSchema,
  approvalViewSchema,
  directUploadResultSchema,
  enterpriseSkillAssignmentPageSchema,
  enterpriseSkillAssignmentSchema,
  partnerWorkflowViewV2Schema,
  partnerEngagementAuthorizationResultSchema,
  partnerInvoiceIntakeResultSchema,
  partnerInvoiceCorrectionResultSchema,
  partnerHandoffResultSchema,
  type AttachmentUpload,
  type AgentWakeInput,
  type ApprovalView,
  type Bootstrap,
  type CatalogPage,
  type EventsPage,
  type Health,
  type Ref,
  type ReplayStream,
  type RunView,
  type WorkspaceCreateInput,
  type EnterpriseSkillAssignmentUpdate,
  type SaveAgentInstruction,
  type PartnerWorkflowViewV2,
  type PartnerWorkflowSetup,
  type PartnerWorkflowAdmissionInput,
  type PartnerEngagementAuthorizationInput,
  type PartnerEngagementAuthorizationResult,
  type PartnerInvoiceIntakeInput,
  type PartnerInvoiceIntakeResult,
  type PartnerInvoiceCorrectionInput,
  type PartnerInvoiceCorrectionResult,
  type PartnerHandoffResult,
} from '@hermes/shared';
import {
  authSessionSchema,
  decisionResultSchema,
  documentEntitySchema,
  eventRowSchema,
  contextFieldSchema,
  instructionVersionSchema,
  invitationEntitySchema,
  memberEntitySchema,
  messageSchema,
  paginatedSchema,
  requestEntitySchema,
  effectEntitySchema,
  sessionSchema,
  shareResponseSchema,
  sharedSessionSchema,
  skillVersionSchema,
  traceEntitySchema,
  usageReportSchema,
  settingsViewSchema,
  dataPrivacySchema,
  attestationResultSchema,
  workspaceDeletionSchema,
  undeleteResultSchema,
  authWorkspacesSchema,
  type AuthWorkspacesResponse,
  type DecideApprovalInput,
  type ReviseApprovalInput,
  type RouteApprovalInput,
  type UsageRange,
  type AttachmentRef,
  type AuthSessionResponse,
  type DecisionResult,
  type Paginated,
  type ShareResponse,
  type SharedSession,
} from '@hermes/shared';
import type { z } from 'zod';
import type { AuthAdapter } from './auth.js';

export class RestError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly retryAfter: number | null = null,
    readonly traceId: string | null = null,
  ) {
    super(message);
    this.name = 'RestError';
  }
  get signedOut(): boolean {
    return this.status === 401 && this.reason !== 'reauth_required';
  }
  get reauthRequired(): boolean {
    return this.status === 401 && this.reason === 'reauth_required';
  }
}

export type FetchLike = typeof fetch;

export interface RestOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  auth: AuthAdapter;
  /** Called with every 401 that is not a step-up challenge. */
  onSignedOut?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

interface CallOptions {
  headers?: Record<string, string>;
  /**
   * Which of our own screens issued this call.
   *
   * Two routes require it and no other may send it: the decision route takes
   * `inbox`, and saving or discarding an instruction version takes `skills`.
   * Both are writes whose danger is a click with manufactured consent, and the
   * header is what says the code path was the review pane rather than a helper
   * that replayed a POST (server: src/domain/guards.ts).
   */
  requestedFrom?: 'inbox' | 'skills';
  retries?: number;
  signal?: AbortSignal;
  /** Bytes sent as-is, with no JSON encoding: the dev direct-upload route. */
  rawBody?: BodyInit;
}

function csrfToken(): string {
  const match = /(?:^|;\s*)hermes_csrf=([^;]+)/.exec(typeof document === 'undefined' ? '' : document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function createRest(options: RestOptions) {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<FetchLike>) => fetch(...args));
  const base = options.baseUrl ?? '';
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function perform(method: string, path: string, schema: z.ZodType | null, body?: unknown, call: CallOptions = {}): Promise<unknown> {
    const retries = call.retries ?? (method === 'GET' ? 2 : 0);
    let attempt = 0;
    for (;;) {
      const headers: Record<string, string> = { Accept: 'application/json', ...options.auth.headers(), ...(call.headers ?? {}) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (UNSAFE.has(method)) headers['X-CSRF-Token'] = csrfToken();
      if (call.requestedFrom) headers['X-Requested-From'] = call.requestedFrom;

      const init: RequestInit = { method, headers, credentials: 'include' };
      if (call.rawBody !== undefined) init.body = call.rawBody;
      else if (body !== undefined) init.body = JSON.stringify(body);
      if (call.signal) init.signal = call.signal;
      const response = await fetchImpl(`${base}${path}`, init);

      if (response.ok) {
        if (response.status === 204 || !schema) return undefined;
        const json: unknown = await response.json();
        const parsed = schema.safeParse(json);
        if (!parsed.success) throw new RestError(response.status, 'contract_violation', `${path}: ${parsed.error.message}`);
        return parsed.data;
      }

      const retryAfter = Number(response.headers.get('Retry-After') ?? '') || null;
      let reason = 'http_error';
      let message = `${method} ${path} failed with ${response.status}`;
      let traceId: string | null = null;
      try {
        const parsed = errorBodySchema.safeParse(await response.json());
        if (parsed.success) {
          reason = parsed.data.reason;
          message = parsed.data.error;
          traceId = parsed.data.trace_id ?? null;
        }
      } catch {
        /* a non-JSON error body keeps the default reason */
      }

      if ((response.status === 502 || response.status === 503) && attempt < retries) {
        attempt += 1;
        await sleep(retryAfter ? retryAfter * 1000 : 500 * attempt);
        continue;
      }

      const error = new RestError(response.status, reason, message, retryAfter, traceId);
      if (error.signedOut) options.onSignedOut?.();
      throw error;
    }
  }

  /** Typed call: the schema is the return type. */
  const request = <S extends z.ZodType>(method: string, path: string, schema: S, body?: unknown, call?: CallOptions): Promise<z.output<S>> =>
    perform(method, path, schema, body, call) as Promise<z.output<S>>;

  /** A call with no body to parse: 204, or a body the client does not read. */
  const send = async (method: string, path: string, body?: unknown, call?: CallOptions): Promise<void> => {
    await perform(method, path, null, body, call);
  };


  const ws = (workspaceId: string) => `/w/${workspaceId}`;

  /**
   * A route this build of the Worker does not serve yet.
   *
   * Three routes the client wants — History, Traces, Usage and the rest of the
   * §5.1 table — are owned by milestones that had not landed when the client
   * was wired up. A 404 whose `reason` is `unknown_route` is the Worker's own
   * "I do not have this", and the honest answer to it is the screen's empty
   * state, not an error banner: the person has no activity to see *and* no way
   * to tell the difference. Any other failure still throws, because a 500 on a
   * route that exists is a bug and silence would hide it.
   */
  const optional = async <T>(call: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof RestError && error.status === 404 && error.reason === 'unknown_route') return fallback;
      throw error;
    }
  };

  const emptyPage = <T>(): Paginated<T> => ({ items: [], cursor: null, total: 0 });

  return {
    request,
    send,
    optional,

    // --- bootstrap, auth, health ---
    bootstrap: (workspaceId: string) => request(`GET`, `${ws(workspaceId)}/bootstrap`, bootstrapSchema) as Promise<Bootstrap>,
    /**
     * With `?ws=`: this workspace's session, its stream heads and a hub ticket.
     *
     * It used to be the only usable form — without `?ws=` the route walked
     * `workspace_directory`, which only the WorkOS mirror writes, and answered
     * 404 for a seeded workspace. Server decision F7 changed that: the bare
     * route now answers who you are and which workspaces you are in, which is
     * what the picker below needs. Two shapes, two schemas, because they mean
     * two different things (`authWorkspaces`).
     */
    authSession: (workspaceId: string) =>
      request('GET', `/auth/session?ws=${encodeURIComponent(workspaceId)}`, authSessionSchema) as Promise<AuthSessionResponse>,
    /** `GET /auth/session` with no `?ws`: the workspace picker's list. */
    authWorkspaces: () => request('GET', '/auth/session', authWorkspacesSchema) as Promise<AuthWorkspacesResponse>,
    health: () => request('GET', '/health', healthSchema) as Promise<Health>,
    /**
     * Replay. The Worker takes `stream=session|workspace` and no session id:
     * the session stream is filtered server-side to what the caller may see, so
     * a client watching one session receives its own other sessions' rows too
     * and drops them by `session_id`.
     */
    events: (workspaceId: string, stream: ReplayStream, after: bigint) =>
      request('GET', `${ws(workspaceId)}/events?stream=${stream}&after=${after.toString()}`, eventsPageSchema) as Promise<EventsPage>,

    // --- turns and runs ---
    // Every control is scoped to a run, not to a session: the Worker's routes
    // are `/sessions/:id/runs/:runId/...`, because "the session's current run"
    // is a race the client would have to win and the server already knows.
    sessionSnapshot: (workspaceId: string, sessionId: string) =>
      request('GET', `${ws(workspaceId)}/sessions/${sessionId}/snapshot`, sessionSnapshotSchema),
    sendTurn: (workspaceId: string, sessionId: string, body: { text: string; client_turn_id: string; attachments: AttachmentRef[]; mode: string; model_id: string; effort: string | null; expected_settings?: SessionSettings }) =>
      request('POST', `${ws(workspaceId)}/sessions/${sessionId}/turns`, runViewSchema, { ...body, attachments: body.attachments.map((source) => ({ id: source.id, sha256: source.sha256, kind: source.kind === 'source' ? 'agent_file' : source.kind })) }) as Promise<RunView>,
    stop: (workspaceId: string, sessionId: string, runId: string) =>
      request('POST', `${ws(workspaceId)}/sessions/${sessionId}/runs/${runId}/stop`, runViewSchema, {}) as Promise<RunView>,
    retry: (workspaceId: string, sessionId: string, runId: string, expectedAttempt: number, expectedSettings?: SessionSettings) =>
      request('POST', `${ws(workspaceId)}/sessions/${sessionId}/runs/${runId}/retry`, runViewSchema, { expected_attempt: expectedAttempt, ...(expectedSettings ? { expected_settings: expectedSettings } : {}) }) as Promise<RunView>,
    agentRecovery: (workspaceId: string, agentId: string, runId?: string) =>
      request('GET', `${ws(workspaceId)}/agents/${agentId}/recovery${runId ? `?run_id=${encodeURIComponent(runId)}` : ''}`, agentRecoveryViewSchema),
    wakeAgent: (workspaceId: string, agentId: string, body: AgentWakeInput) =>
      request('POST', `${ws(workspaceId)}/agents/${agentId}/wake`, agentRecoveryViewSchema, body),
    guide: (workspaceId: string, sessionId: string, runId: string, text: string) =>
      request('POST', `${ws(workspaceId)}/sessions/${sessionId}/runs/${runId}/guide`, guidanceAcceptedSchema, { text }),
    enqueue: (workspaceId: string, sessionId: string, runId: string, text: string) =>
      request('POST', `${ws(workspaceId)}/sessions/${sessionId}/runs/${runId}/queue`, queueStateSchema, { text }),
    editQueued: (workspaceId: string, sessionId: string, runId: string, itemId: string, text: string) =>
      request('PATCH', `${ws(workspaceId)}/sessions/${sessionId}/runs/${runId}/queue/${itemId}`, queueStateSchema, { text }),
    removeQueued: (workspaceId: string, sessionId: string, runId: string, itemId: string) =>
      request('DELETE', `${ws(workspaceId)}/sessions/${sessionId}/runs/${runId}/queue/${itemId}`, queueStateSchema),
    answerContext: (workspaceId: string, sessionId: string, runId: string, key: string, value: string) =>
      send('POST', `${ws(workspaceId)}/sessions/${sessionId}/runs/${runId}/context`, { key, value }),

    // --- sessions ---
    sessions: (workspaceId: string, query = '') => request('GET', `${ws(workspaceId)}/sessions${query}`, paginatedSchema(sessionSchema)) as Promise<Paginated<z.infer<typeof sessionSchema>>>,
    createSession: (workspaceId: string, body: { title?: string; mode?: string; runtime?: string; agent_id?: string }) => request('POST', `${ws(workspaceId)}/sessions`, sessionSchema, body),
    patchSession: (workspaceId: string, sessionId: string, patch: Record<string, unknown>) => request('PATCH', `${ws(workspaceId)}/sessions/${sessionId}`, sessionSchema, patch),
    deleteSession: (workspaceId: string, sessionId: string) => send('DELETE', `${ws(workspaceId)}/sessions/${sessionId}`),
    messages: (workspaceId: string, sessionId: string, before: number | null, limit = 100) =>
      request('GET', `${ws(workspaceId)}/sessions/${sessionId}/messages?${before == null ? '' : `before=${before}&`}limit=${limit}`, paginatedSchema(messageSchema)) as Promise<Paginated<z.infer<typeof messageSchema>>>,
    run: (workspaceId: string, sessionId: string, runId: string) =>
      request('GET', `${ws(workspaceId)}/sessions/${sessionId}/runs/${runId}`, runViewSchema) as Promise<RunView>,

    // --- decisions and effects: the guarded paths ---
    // The decisions route is M4's and may not exist yet; `optional` is not used
    // here on purpose. A decision that silently did nothing is the one failure
    // this product cannot have, so a missing route surfaces as an error.
    decide: (workspaceId: string, requestId: string, body: { decision: 'approve' | 'decline'; note?: string; expected_version?: number; expected_payload_hash?: `sha256:${string}` }) =>
      request('POST', `${ws(workspaceId)}/requests/${requestId}/decisions`, decisionResultSchema, body, { requestedFrom: 'inbox' }) as Promise<DecisionResult>,
    getApproval: (workspaceId: string, requestId: string) =>
      request('GET', `${ws(workspaceId)}/requests/${requestId}/approval`, approvalViewSchema) as Promise<ApprovalView>,
    getApprovalEvidence: (workspaceId: string, requestId: string, evidenceId: string) =>
      request('GET', `${ws(workspaceId)}/requests/${requestId}/approval/evidence/${encodeURIComponent(evidenceId)}`, approvalEvidenceViewSchema) as Promise<ApprovalEvidenceView>,
    decideApproval: (workspaceId: string, requestId: string, body: DecideApprovalInput) =>
      request('POST', `${ws(workspaceId)}/requests/${requestId}/approval/decisions`, approvalViewSchema, body, { requestedFrom: 'inbox' }) as Promise<ApprovalView>,
    reviseApproval: (workspaceId: string, requestId: string, body: ReviseApprovalInput) =>
      request('POST', `${ws(workspaceId)}/requests/${requestId}/approval/revisions`, approvalViewSchema, body, { requestedFrom: 'inbox' }) as Promise<ApprovalView>,
    routeApproval: (workspaceId: string, requestId: string, body: RouteApprovalInput) =>
      request('POST', `${ws(workspaceId)}/requests/${requestId}/approval/route`, approvalViewSchema, body, { requestedFrom: 'inbox' }) as Promise<ApprovalView>,
    executeEffect: (workspaceId: string, effectId: string) => request('POST', `${ws(workspaceId)}/effects/${effectId}/execute`, effectEntitySchema, {}),

    // --- entities ---
    getRequest: (workspaceId: string, id: string) => request('GET', `${ws(workspaceId)}/requests/${id}`, requestEntitySchema),
    addRequestNote: (workspaceId: string, id: string, body: { body: string }) =>
      request('POST', `${ws(workspaceId)}/requests/${id}/notes`, requestEntitySchema, body),
    listRequests: (workspaceId: string, query = '') =>
      optional(() => request('GET', `${ws(workspaceId)}/requests${query}`, paginatedSchema(requestEntitySchema)), emptyPage()),
    listEffects: (workspaceId: string, requestId: string) =>
      optional(() => request('GET', `${ws(workspaceId)}/requests/${requestId}/effects`, paginatedSchema(effectEntitySchema)), emptyPage()),
    getDocument: (workspaceId: string, id: string) => request('GET', `${ws(workspaceId)}/documents/${id}`, documentEntitySchema),
    listDocuments: (workspaceId: string, query = '') =>
      optional(() => request('GET', `${ws(workspaceId)}/documents${query}`, paginatedSchema(documentEntitySchema)), emptyPage()),
    listMembers: (workspaceId: string) => request('GET', `${ws(workspaceId)}/members`, paginatedSchema(memberEntitySchema)),
    listInvitations: (workspaceId: string) => request('GET', `${ws(workspaceId)}/invitations`, paginatedSchema(invitationEntitySchema)),
    listEvents: (workspaceId: string, query = '') =>
      optional(() => request('GET', `${ws(workspaceId)}/history${query}`, paginatedSchema(eventRowSchema)), emptyPage()),
    listTraces: (workspaceId: string, query = '') =>
      optional(() => request('GET', `${ws(workspaceId)}/traces${query}`, paginatedSchema(traceEntitySchema)), emptyPage()),
    getTrace: (workspaceId: string, id: string) => request('GET', `${ws(workspaceId)}/traces/${id}`, traceEntitySchema),
    listContextFields: (workspaceId: string) =>
      optional(() => request('GET', `${ws(workspaceId)}/context-fields`, paginatedSchema(contextFieldSchema)), emptyPage()),
    listContextNotes: (workspaceId: string, agentId: string) => request('GET', `${ws(workspaceId)}/agents/${agentId}/context-notes`, paginatedSchema(contextNoteSchema)),
    createContextNote: (workspaceId: string, agentId: string, body: { title: string; text: string }) => request('POST', `${ws(workspaceId)}/agents/${agentId}/context-notes`, contextNoteSchema, body),
    updateContextNote: (workspaceId: string, agentId: string, id: string, body: { title: string; text: string; expected_revision: number }) => request('PATCH', `${ws(workspaceId)}/agents/${agentId}/context-notes/${id}`, contextNoteSchema, body),
    deleteContextNote: (workspaceId: string, agentId: string, id: string, expectedRevision: number) => send('DELETE', `${ws(workspaceId)}/agents/${agentId}/context-notes/${id}`, { expected_revision: expectedRevision }),
    agentPermissions: (workspaceId: string, agentId: string) => request('GET', `${ws(workspaceId)}/agents/${agentId}/permissions`, agentPermissionsSchema),
    setAgentPermission: (workspaceId: string, agentId: string, body: { revision: number; operation_id: string; require_human_approval: boolean }) => request('PATCH', `${ws(workspaceId)}/agents/${agentId}/permissions`, agentPermissionsSchema, body),
    decideOperationApproval: (workspaceId: string, agentId: string, id: string, decision: 'approved' | 'denied') => request('POST', `${ws(workspaceId)}/agents/${agentId}/permissions/approvals/${id}`, agentPermissionsSchema, { decision }),
    setContextField: (workspaceId: string, field: string, body: { value: string; scope: 'reply' | 'future' }) =>
      request('PATCH', `${ws(workspaceId)}/context-fields/${field}`, contextFieldSchema, body),
    listInstructions: (workspaceId: string, agentId?: string | null) =>
      request('GET', `${ws(workspaceId)}/instructions${agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''}`, paginatedSchema(instructionVersionSchema)),
    saveInstruction: (workspaceId: string, agentId: string, body: SaveAgentInstruction) =>
      request('POST', `${ws(workspaceId)}/instructions?agent_id=${encodeURIComponent(agentId)}`, instructionVersionSchema, body, { requestedFrom: 'skills' }),
    acceptInstruction: (workspaceId: string, id: string, agentId?: string | null) =>
      request('POST', `${ws(workspaceId)}/instructions/${id}/accept${agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''}`, instructionVersionSchema, {}, { requestedFrom: 'skills' }),
    discardInstruction: (workspaceId: string, id: string, agentId?: string | null) =>
      request('POST', `${ws(workspaceId)}/instructions/${id}/discard${agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''}`, instructionVersionSchema, {}, { requestedFrom: 'skills' }),
    listSkills: (workspaceId: string, agentId?: string | null) =>
      optional(() => request('GET', `${ws(workspaceId)}/skills${agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''}`, paginatedSchema(skillVersionSchema)), emptyPage()),
    adoptSkill: (workspaceId: string, id: string, agentId?: string | null) => request('POST', `${ws(workspaceId)}/skills/${id}/adopt${agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''}`, skillVersionSchema, {}),
    listSkillAssignments: (workspaceId: string, agentId: string) =>
      request('GET', `${ws(workspaceId)}/agents/${agentId}/skill-assignments`, enterpriseSkillAssignmentPageSchema),
    updateSkillAssignment: (workspaceId: string, agentId: string, id: string, body: EnterpriseSkillAssignmentUpdate) =>
      request('PATCH', `${ws(workspaceId)}/agents/${agentId}/skill-assignments/${id}`, enterpriseSkillAssignmentSchema, body),
    partnerWorkflow: (workspaceId: string) =>
      optional(() => request('GET', `${ws(workspaceId)}/partner-workflow`, partnerWorkflowViewV2Schema), {
        configured: false,
        admission_state: 'disabled' as const,
        viewer_role: 'unrelated' as const,
        actions: { configure: false, set_admission: false, propose_engagement: false, submit_invoice: false, correct_invoice: false, view_finance_review: false },
        teams: [],
        agents: [],
        readiness: [
          { role: 'partnerships' as const, configured: false, assignment_state: 'missing' as const, native_status: 'unknown' as const, skill_key: 'partner-program-screening' as const, skill_version: null, artifact_digest: null, missing: ['principal' as const, 'agent' as const, 'assignment' as const, 'skill' as const, 'tools' as const, 'provider' as const] },
          { role: 'finance' as const, configured: false, assignment_state: 'missing' as const, native_status: 'unknown' as const, skill_key: 'partner-invoice-review' as const, skill_version: null, artifact_digest: null, missing: ['principal' as const, 'agent' as const, 'assignment' as const, 'skill' as const, 'tools' as const, 'provider' as const] },
        ],
        partner_options: [],
        engagements: [],
        handoffs: [],
        connector: {
          name: 'enterprise-partner-records' as const,
          shared_code: true as const,
          enforcement: 'server' as const,
          summary: 'Shared identity and approved engagement evidence only; private research and invoice data stay team-scoped.' as const,
        },
      }) as Promise<PartnerWorkflowViewV2>,
    configurePartnerWorkflow: (workspaceId: string, body: PartnerWorkflowSetup) =>
      request('POST', `${ws(workspaceId)}/partner-workflow/configure`, partnerWorkflowViewV2Schema, body) as Promise<PartnerWorkflowViewV2>,
    setPartnerWorkflowAdmission: (workspaceId: string, body: PartnerWorkflowAdmissionInput) =>
      request('POST', `${ws(workspaceId)}/partner-workflow/admission`, partnerWorkflowViewV2Schema, body) as Promise<PartnerWorkflowViewV2>,
    proposePartnerEngagement: (workspaceId: string, body: PartnerEngagementAuthorizationInput) =>
      request('POST', `${ws(workspaceId)}/partner-workflow/engagement-authorizations`, partnerEngagementAuthorizationResultSchema, body) as Promise<PartnerEngagementAuthorizationResult>,
    submitPartnerInvoice: (workspaceId: string, body: PartnerInvoiceIntakeInput) =>
      request('POST', `${ws(workspaceId)}/partner-workflow/invoice-intakes`, partnerInvoiceIntakeResultSchema, body) as Promise<PartnerInvoiceIntakeResult>,
    correctPartnerInvoice: (workspaceId: string, handoffId: string, body: PartnerInvoiceCorrectionInput) =>
      request('POST', `${ws(workspaceId)}/partner-workflow/handoffs/${handoffId}/corrections`, partnerInvoiceCorrectionResultSchema, body) as Promise<PartnerInvoiceCorrectionResult>,
    partnerHandoffResult: (workspaceId: string, handoffId: string) =>
      request('GET', `${ws(workspaceId)}/partner-workflow/handoffs/${handoffId}/result`, partnerHandoffResultSchema) as Promise<PartnerHandoffResult>,

    // --- members and invitations ---
    invite: (workspaceId: string, body: { email: string; role: 'admin' | 'member' }) => request('POST', `${ws(workspaceId)}/invitations`, invitationEntitySchema, body),
    setMemberRole: (workspaceId: string, id: string, role: 'admin' | 'member') => request('PATCH', `${ws(workspaceId)}/members/${id}`, memberEntitySchema, { role }),
    removeMember: (workspaceId: string, id: string) => send('DELETE', `${ws(workspaceId)}/members/${id}`),
    /**
     * A resend writes a *new* invitation and supersedes the old one, so the
     * server answers with the successor row; "Reinvite" on an expired row is
     * the same route, because the server accepts `pending` and `expired` alike
     * and the only thing that differs is the word on the button.
     */
    resendInvitation: (workspaceId: string, id: string) =>
      request('POST', `${ws(workspaceId)}/invitations/${id}/resend`, invitationEntitySchema, {}),
    withdrawInvitation: (workspaceId: string, id: string) => send('POST', `${ws(workspaceId)}/invitations/${id}/withdraw`, {}),

    // --- shares, feedback ---
    share: (workspaceId: string, sessionId: string) => request('POST', `${ws(workspaceId)}/sessions/${sessionId}/shares`, shareResponseSchema) as Promise<ShareResponse>,
    unshare: (workspaceId: string, sessionId: string, shareId: string) => send('DELETE', `${ws(workspaceId)}/sessions/${sessionId}/shares/${shareId}`),
    sharedSession: (token: string, etag: string | null) =>
      request('GET', `/shared/${token}`, sharedSessionSchema, undefined, etag ? { headers: { 'If-None-Match': etag } } : {}) as Promise<SharedSession>,
    setFeedback: (workspaceId: string, messageId: string, value: 'helpful' | 'not-helpful') => send('PUT', `${ws(workspaceId)}/messages/${messageId}/feedback`, { value }),
    clearFeedback: (workspaceId: string, messageId: string) => send('DELETE', `${ws(workspaceId)}/messages/${messageId}/feedback`),

    // --- uploads ---
    // Two tables behind one flow. `attachments` are a turn's files; `files` are
    // the agent's Context sources. The routes are identical apart from the
    // prefix, so one pair of helpers takes the kind.
    declareUpload: (workspaceId: string, kind: 'attachment' | 'agent_file', body: { name: string; size: number; mime: string; session_id?: string; agent_id?: string }) =>
      request('POST', `${ws(workspaceId)}/${kind === 'attachment' ? 'attachments' : 'files'}`, attachmentUploadSchema, body) as Promise<AttachmentUpload>,
    completeUpload: (workspaceId: string, kind: 'attachment' | 'agent_file', id: string) =>
      request('POST', `${ws(workspaceId)}/${kind === 'attachment' ? 'attachments' : 'files'}/${id}/complete`, attachmentSchema, {}),
    getUpload: (workspaceId: string, kind: 'attachment' | 'agent_file', id: string) =>
      request('GET', `${ws(workspaceId)}/${kind === 'attachment' ? 'attachments' : 'files'}/${id}`, attachmentDetailSchema),
    deleteUpload: (workspaceId: string, kind: 'attachment' | 'agent_file', id: string) =>
      send('DELETE', `${ws(workspaceId)}/${kind === 'attachment' ? 'attachments' : 'files'}/${id}`),
    /** The agent's Context sources, with their extraction status. */
    listAgentFiles: (workspaceId: string, agentId?: string | null) => request('GET', `${ws(workspaceId)}/files${agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''}`, paginatedSchema(attachmentDetailSchema)),
    /**
     * The bytes. In a deployed environment `upload.url` is a presigned R2 PUT
     * and this goes straight to R2 with no cookie; in `wrangler dev --local`
     * there are no S3 credentials, so the Worker answers its own dev-only
     * direct route and the request needs the session. `upload.direct` says
     * which, so the client never has to guess from the URL.
     */
    putBytes: async (upload: AttachmentUpload['upload'], body: Blob | ArrayBuffer) => {
      if (!upload.direct) {
        const response = await fetchImpl(upload.url, { method: 'PUT', headers: upload.headers, body: body as BodyInit });
        if (!response.ok) throw new RestError(response.status, 'upload_failed', `PUT to storage failed with ${response.status}`);
        return;
      }
      await request('PUT', new URL(upload.url, 'http://placeholder.invalid').pathname, directUploadResultSchema, undefined, {
        headers: upload.headers,
        rawBody: body as BodyInit,
      });
    },

    // --- provider keys (every mutation needs step-up) ---
    providerKeys: (workspaceId: string) => request('GET', `${ws(workspaceId)}/provider-keys`, providerKeyListSchema),
    addProviderKey: (workspaceId: string, body: { provider: string; label?: string; key: string }) =>
      request('POST', `${ws(workspaceId)}/provider-keys`, providerKeyMutationSchema, body),
    verifyProviderKey: (workspaceId: string, id: string) => request('POST', `${ws(workspaceId)}/provider-keys/${id}/verify`, providerKeyVerifySchema, {}),
    rotateProviderKey: (workspaceId: string, id: string, key: string) =>
      request('POST', `${ws(workspaceId)}/provider-keys/${id}/rotate`, providerKeyMutationSchema, { key }),
    removeProviderKey: (workspaceId: string, id: string) => request('DELETE', `${ws(workspaceId)}/provider-keys/${id}`, providerKeyRemovedSchema),
    slackConnection: (workspaceId: string) => request('GET', `${ws(workspaceId)}/integrations/slack`, slackConnectionSchema),
    startSlackOAuth: (workspaceId: string) => request('POST', `${ws(workspaceId)}/integrations/slack/oauth/start`, slackOAuthStartSchema, {}),
    createSlackLinkCode: (workspaceId: string) => request('POST', `${ws(workspaceId)}/integrations/slack/link-code`, slackLinkCodeSchema, {}),
    disconnectSlack: (workspaceId: string) => request('DELETE', `${ws(workspaceId)}/integrations/slack`, slackDisconnectSchema),
    outboundEmailConnection: (workspaceId: string) => request('GET', `${ws(workspaceId)}/integrations/email`, outboundEmailConnectionSchema),
    startGmailOAuth: (workspaceId: string) => request('POST', `${ws(workspaceId)}/integrations/email/gmail/oauth/start`, outboundEmailOAuthStartSchema, {}),
    startNousOAuth: (workspaceId: string) => request('POST', `${ws(workspaceId)}/provider-connections/nous/start`, providerOAuthStartSchema, {}),
    pollNousOAuth: (workspaceId: string, id: string) => request('POST', `${ws(workspaceId)}/provider-connections/nous/${id}/poll`, providerOAuthPollSchema, {}),
    /** The model menu. Any member may read it; only the key rows need step-up. */
    /**
     * One page of the catalog. Since Nous Portal the table is hundreds of rows,
     * so the model menu asks for the page it is showing and the search runs in
     * SQL rather than over a list the client downloaded.
     */
    catalog: (workspaceId: string, query: { q?: string; provider?: string; limit?: number; after?: string } = {}) => {
      const params = new URLSearchParams();
      if (query.q !== undefined && query.q !== '') params.set('q', query.q);
      if (query.provider !== undefined && query.provider !== '') params.set('provider', query.provider);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.after !== undefined && query.after !== '') params.set('after', query.after);
      const suffix = params.size === 0 ? '' : `?${params.toString()}`;
      return request('GET', `${ws(workspaceId)}/catalog${suffix}`, catalogPageSchema) as Promise<CatalogPage>;
    },

    // --- settings, usage, onboarding ---
    settings: (workspaceId: string) => request('GET', `${ws(workspaceId)}/settings`, settingsViewSchema),
    /**
     * One route, two authorisations: the workspace fields need Admin, a body
     * carrying only `notifications` does not. The answer is the whole view, so
     * the screen re-renders from what was actually stored rather than from what
     * it hoped it sent.
     */
    patchSettings: (workspaceId: string, patch: Record<string, unknown>) =>
      request('PATCH', `${ws(workspaceId)}/settings`, settingsViewSchema, patch),
    patchAgent: (workspaceId: string, agentId: string, patch: Record<string, unknown>) => optional(() => send('PATCH', `${ws(workspaceId)}/agents/${agentId}`, patch), undefined),
    agentProvisioning: (workspaceId: string, agentId: string) =>
      request('GET', `${ws(workspaceId)}/agents/${agentId}/provisioning`, agentProvisioningResponseSchema),
    /**
     * `?range=`, not `?from=&to=&group=`. The client asked for a shape nobody
     * served and parsed the answer against a schema nobody wrote: every call
     * was a `contract_violation`. Decision C25.
     */
    usage: (workspaceId: string, range: UsageRange) =>
      request('GET', `${ws(workspaceId)}/usage?range=${range}`, usageReportSchema),
    dataPrivacy: (workspaceId: string) => request('GET', `${ws(workspaceId)}/settings/data-privacy`, dataPrivacySchema),
    /** Admin + step-up. The claim is recorded against the person who made it. */
    setAttestation: (workspaceId: string, keyId: string, body: { kind: string; reference?: string; note?: string }) =>
      request('PATCH', `${ws(workspaceId)}/provider-keys/${keyId}/attestation`, attestationResultSchema, body),
    /** Admin + step-up. Access is revoked now; destruction is seven days away. */
    deleteWorkspace: (workspaceId: string) => request('DELETE', ws(workspaceId), workspaceDeletionSchema),
    undeleteWorkspace: (workspaceId: string) => request('POST', `${ws(workspaceId)}/settings/undelete`, undeleteResultSchema, {}),
    createWorkspace: (body: WorkspaceCreateInput) => request('POST', '/workspaces', bootstrapSchema, body),
    /**
     * The whole workspace, from inside the transaction that admitted them —
     * so the shell renders with no second round trip (server decision F2).
     */
    acceptInvitation: (token: string) => request('POST', `/invitations/${encodeURIComponent(token)}/accept`, bootstrapSchema, {}),

    setFocusRef: (workspaceId: string, sessionId: string, ref: Ref | null) => request('PATCH', `${ws(workspaceId)}/sessions/${sessionId}`, sessionSchema, { focus_ref: ref }),
  };
}

export type Rest = ReturnType<typeof createRest>;
