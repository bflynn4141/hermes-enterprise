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
  errorBodySchema,
  eventsPageSchema,
  healthSchema,
  providerKeyListSchema,
  type Bootstrap,
  type EventsPage,
  type Health,
  type Ref,
} from '@hermes/shared';
import {
  attachmentPresignSchema,
  authSessionSchema,
  clientBootstrapSchema,
  decisionResultSchema,
  documentEntitySchema,
  eventRowSchema,
  agentFileSchema,
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
  turnResponseSchema,
  usageResponseSchema,
  type AttachmentPresign,
  type AttachmentRef,
  type AuthSessionResponse,
  type ClientBootstrapExtra,
  type DecisionResult,
  type Paginated,
  type ShareResponse,
  type SharedSession,
  type TurnResponse,
} from '@hermes/shared';
import type { z } from 'zod';
import type { AuthAdapter } from './auth.js';

export class RestError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly retryAfter: number | null = null,
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
  /** Decisions carry `X-Requested-From: inbox`; nothing else may. */
  requestedFrom?: 'inbox';
  retries?: number;
  signal?: AbortSignal;
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
      if (body !== undefined) init.body = JSON.stringify(body);
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
      try {
        const parsed = errorBodySchema.safeParse(await response.json());
        if (parsed.success) {
          reason = parsed.data.reason;
          message = parsed.data.error;
        }
      } catch {
        /* a non-JSON error body keeps the default reason */
      }

      if ((response.status === 502 || response.status === 503) && attempt < retries) {
        attempt += 1;
        await sleep(retryAfter ? retryAfter * 1000 : 500 * attempt);
        continue;
      }

      const error = new RestError(response.status, reason, message, retryAfter);
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

  return {
    request,
    send,

    // --- bootstrap, auth, health ---
    bootstrap: (workspaceId: string) => request(`GET`, `${ws(workspaceId)}/bootstrap`, bootstrapSchema) as Promise<Bootstrap>,
    bootstrapExtra: (workspaceId: string) => request('GET', `${ws(workspaceId)}/bootstrap/client`, clientBootstrapSchema) as Promise<ClientBootstrapExtra>,
    authSession: () => request('GET', '/auth/session', authSessionSchema) as Promise<AuthSessionResponse>,
    health: () => request('GET', '/health', healthSchema) as Promise<Health>,
    events: (workspaceId: string, stream: string, after: bigint) =>
      request('GET', `${ws(workspaceId)}/events?stream=${encodeURIComponent(stream)}&after=${after.toString()}`, eventsPageSchema) as Promise<EventsPage>,

    // --- turns and runs ---
    sendTurn: (workspaceId: string, sessionId: string, body: { text: string; client_turn_id: string; attachments: AttachmentRef[]; mode: string; model_id: string; effort: string | null }) =>
      request('POST', `${ws(workspaceId)}/sessions/${sessionId}/turns`, turnResponseSchema, body) as Promise<TurnResponse>,
    stop: (workspaceId: string, sessionId: string) => send('POST', `${ws(workspaceId)}/sessions/${sessionId}/stop`, {}),
    retry: (workspaceId: string, sessionId: string, runId: string) => send('POST', `${ws(workspaceId)}/sessions/${sessionId}/runs/${runId}/retry`, {}),
    guide: (workspaceId: string, sessionId: string, text: string) => send('POST', `${ws(workspaceId)}/sessions/${sessionId}/guide`, { text }),
    enqueue: (workspaceId: string, sessionId: string, text: string) => send('POST', `${ws(workspaceId)}/sessions/${sessionId}/queue`, { text }),
    editQueued: (workspaceId: string, sessionId: string, itemId: string, text: string) => send('PATCH', `${ws(workspaceId)}/sessions/${sessionId}/queue/${itemId}`, { text }),
    removeQueued: (workspaceId: string, sessionId: string, itemId: string) => send('DELETE', `${ws(workspaceId)}/sessions/${sessionId}/queue/${itemId}`),

    // --- sessions ---
    sessions: (workspaceId: string, query = '') => request('GET', `${ws(workspaceId)}/sessions${query}`, paginatedSchema(sessionSchema)) as Promise<Paginated<z.infer<typeof sessionSchema>>>,
    createSession: (workspaceId: string, body: { title?: string; mode?: string; runtime?: string }) => request('POST', `${ws(workspaceId)}/sessions`, sessionSchema, body),
    patchSession: (workspaceId: string, sessionId: string, patch: Record<string, unknown>) => request('PATCH', `${ws(workspaceId)}/sessions/${sessionId}`, sessionSchema, patch),
    deleteSession: (workspaceId: string, sessionId: string) => send('DELETE', `${ws(workspaceId)}/sessions/${sessionId}`),
    messages: (workspaceId: string, sessionId: string, before: number | null, limit = 100) =>
      request('GET', `${ws(workspaceId)}/sessions/${sessionId}/messages?${before == null ? '' : `before=${before}&`}limit=${limit}`, paginatedSchema(messageSchema)) as Promise<Paginated<z.infer<typeof messageSchema>>>,

    // --- decisions and effects: the guarded paths ---
    decide: (workspaceId: string, requestId: string, body: { decision: 'approve' | 'decline'; note?: string }) =>
      request('POST', `${ws(workspaceId)}/requests/${requestId}/decisions`, decisionResultSchema, body, { requestedFrom: 'inbox' }) as Promise<DecisionResult>,
    executeEffect: (workspaceId: string, effectId: string) => request('POST', `${ws(workspaceId)}/effects/${effectId}/execute`, effectEntitySchema, {}),

    // --- entities ---
    getRequest: (workspaceId: string, id: string) => request('GET', `${ws(workspaceId)}/requests/${id}`, requestEntitySchema),
    listRequests: (workspaceId: string, query = '') => request('GET', `${ws(workspaceId)}/requests${query}`, paginatedSchema(requestEntitySchema)),
    listEffects: (workspaceId: string, requestId: string) => request('GET', `${ws(workspaceId)}/requests/${requestId}/effects`, paginatedSchema(effectEntitySchema)),
    getDocument: (workspaceId: string, id: string) => request('GET', `${ws(workspaceId)}/documents/${id}`, documentEntitySchema),
    listDocuments: (workspaceId: string, query = '') => request('GET', `${ws(workspaceId)}/documents${query}`, paginatedSchema(documentEntitySchema)),
    listMembers: (workspaceId: string) => request('GET', `${ws(workspaceId)}/members`, paginatedSchema(memberEntitySchema)),
    listInvitations: (workspaceId: string) => request('GET', `${ws(workspaceId)}/invitations`, paginatedSchema(invitationEntitySchema)),
    listEvents: (workspaceId: string, query = '') => request('GET', `${ws(workspaceId)}/history${query}`, paginatedSchema(eventRowSchema)),
    listTraces: (workspaceId: string, query = '') => request('GET', `${ws(workspaceId)}/traces${query}`, paginatedSchema(traceEntitySchema)),
    getTrace: (workspaceId: string, id: string) => request('GET', `${ws(workspaceId)}/traces/${id}`, traceEntitySchema),
    listAgentFiles: (workspaceId: string) => request('GET', `${ws(workspaceId)}/agent-files`, paginatedSchema(agentFileSchema)),
    listContextFields: (workspaceId: string) => request('GET', `${ws(workspaceId)}/context-fields`, paginatedSchema(contextFieldSchema)),
    setContextField: (workspaceId: string, field: string, body: { value: string; scope: 'reply' | 'future' }) =>
      request('PATCH', `${ws(workspaceId)}/context-fields/${field}`, contextFieldSchema, body),
    listInstructions: (workspaceId: string) => request('GET', `${ws(workspaceId)}/instructions`, paginatedSchema(instructionVersionSchema)),
    proposeInstruction: (workspaceId: string, text: string) => request('POST', `${ws(workspaceId)}/instructions`, instructionVersionSchema, { text }),
    saveInstruction: (workspaceId: string, id: string) => request('POST', `${ws(workspaceId)}/instructions/${id}/save`, instructionVersionSchema, {}),
    discardInstruction: (workspaceId: string, id: string) => send('DELETE', `${ws(workspaceId)}/instructions/${id}`),
    listSkills: (workspaceId: string) => request('GET', `${ws(workspaceId)}/skills`, paginatedSchema(skillVersionSchema)),
    adoptSkill: (workspaceId: string, id: string) => request('POST', `${ws(workspaceId)}/skills/${id}/adopt`, skillVersionSchema, {}),

    // --- members and invitations ---
    invite: (workspaceId: string, body: { email: string; role: 'admin' | 'member' }) => request('POST', `${ws(workspaceId)}/invitations`, invitationEntitySchema, body),
    acceptInvitation: (token: string) => request('POST', `/invitations/${token}/accept`, memberEntitySchema, {}),
    setMemberRole: (workspaceId: string, id: string, role: 'admin' | 'member') => request('PATCH', `${ws(workspaceId)}/members/${id}`, memberEntitySchema, { role }),
    removeMember: (workspaceId: string, id: string) => send('DELETE', `${ws(workspaceId)}/members/${id}`),

    // --- shares, feedback, attachments ---
    share: (workspaceId: string, sessionId: string, audience: string) => request('POST', `${ws(workspaceId)}/sessions/${sessionId}/shares`, shareResponseSchema, { audience }) as Promise<ShareResponse>,
    unshare: (workspaceId: string, sessionId: string, shareId: string) => send('DELETE', `${ws(workspaceId)}/sessions/${sessionId}/shares/${shareId}`),
    sharedSession: (token: string, etag: string | null) =>
      request('GET', `/shared/${token}`, sharedSessionSchema, undefined, etag ? { headers: { 'If-None-Match': etag } } : {}) as Promise<SharedSession>,
    setFeedback: (workspaceId: string, messageId: string, value: 'helpful' | 'not-helpful') => send('PUT', `${ws(workspaceId)}/messages/${messageId}/feedback`, { value }),
    clearFeedback: (workspaceId: string, messageId: string) => send('DELETE', `${ws(workspaceId)}/messages/${messageId}/feedback`),
    presignAttachment: (workspaceId: string, body: { filename: string; mime: string; size: number }) =>
      request('POST', `${ws(workspaceId)}/attachments`, attachmentPresignSchema, body) as Promise<AttachmentPresign>,
    completeAttachment: (workspaceId: string, id: string, body: { sha256: string; mime: string; size: number }) => send('POST', `${ws(workspaceId)}/attachments/${id}/complete`, body),

    // --- provider keys (every mutation needs step-up) ---
    providerKeys: (workspaceId: string) => request('GET', `${ws(workspaceId)}/provider-keys`, providerKeyListSchema),
    addProviderKey: (workspaceId: string, body: { provider: string; label: string; key: string }) => request('POST', `${ws(workspaceId)}/provider-keys`, providerKeyListSchema, body),
    verifyProviderKey: (workspaceId: string, id: string) => request('POST', `${ws(workspaceId)}/provider-keys/${id}/verify`, providerKeyListSchema, {}),
    rotateProviderKey: (workspaceId: string, id: string, key: string) => request('POST', `${ws(workspaceId)}/provider-keys/${id}/rotate`, providerKeyListSchema, { key }),
    removeProviderKey: (workspaceId: string, id: string) => send('DELETE', `${ws(workspaceId)}/provider-keys/${id}`),

    // --- settings, usage, onboarding ---
    patchSettings: (workspaceId: string, patch: Record<string, unknown>) => send('PATCH', `${ws(workspaceId)}/settings`, patch),
    patchAgent: (workspaceId: string, agentId: string, patch: Record<string, unknown>) => send('PATCH', `${ws(workspaceId)}/agents/${agentId}`, patch),
    usage: (workspaceId: string, from: string, to: string, group: 'day' | 'session' | 'key') =>
      request('GET', `${ws(workspaceId)}/usage?from=${from}&to=${to}&group=${group}`, usageResponseSchema),
    createWorkspace: (body: { name: string }) => request('POST', '/workspaces', bootstrapSchema, body),

    /** Used only by the Redeploying banner poll, and only while it is showing. */
    setFocusRef: (workspaceId: string, sessionId: string, ref: Ref | null) => request('PATCH', `${ws(workspaceId)}/sessions/${sessionId}`, sessionSchema, { focus_ref: ref }),
  };
}

export type Rest = ReturnType<typeof createRest>;
