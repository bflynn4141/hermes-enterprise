// POST /w/:ws/requests/:id/decisions
//
// The only writer of `decisions`. (Typed approvals change a request's status
// through `/approval/decisions` in routes/approvals.ts, behind the same
// Origin, surface, CSRF and step-up guards.) Everything about it is deliberate, so it is worth
// reading the five guards in the order they run and what each one is for:
//
//   1. **An allowlisted `Origin`, required.** Every other state-changing route
//      allows a missing `Origin`, because `curl` and the tests are not browsers
//      and the cookie rules already cover the browser case. This one does not:
//      a decision is the highest-value write in the product, and "the request
//      did not say where it came from" is not an answer we accept for it.
//   2. **`X-Requested-From: inbox`.** Which surface of our own client issued
//      it. A custom header also forces a CORS preflight, so a cross-site form
//      post or a link cannot reach this route at all (src/domain/guards.ts).
//   3. **Double-submit CSRF.** The cookie and the header must agree.
//   4. **An authorized human session.** Legacy requests still require the
//      workspace Admin. A Finance-workflow invoice is additionally decidable
//      by its named active audience member when that person holds the Finance
//      reviewer role. The agent is never an eligible reviewer.
//   5. **Step-up.** WorkOS `auth_time` must be within five minutes. The callback
//      persists it in `auth_sessions.authenticated_at`; token `iat` moves on
//      ordinary refresh and is not evidence of a new challenge. Otherwise 401
//      `reauth_required`, and the client sends the person through
//      `/auth/login?step_up=1`.
//
// Then one transaction (src/domain/decisions.ts), then the jobs.
//
// ## Two tabs
//
// `decisions.request_id` is UNIQUE and the request row is locked FOR UPDATE, so
// the second of two concurrent decisions on one request finds the first one
// committed and returns it. The status is 200 rather than 201 and the response
// carries `X-Hermes-Conflict: true`; the body is the decision that exists,
// because what the person in the second tab needs is the outcome, not an error
// about a race they did not know they were in.
//
// The header rather than a body field because `decisionResultSchema` is
// `.strict()`: the contract names four fields and a fifth would fail to parse
// in the client. The status code carries the same information and is the older
// convention for it (docs/DECISIONS.md, D-3).
import type { Context } from 'hono';
import { decisionResultSchema, type Decision } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { inWorkspace, jsonBody, pathUuid } from './tenant.js';
import { RouteError } from './errors.js';
import { requireRequestedFrom } from '../domain/guards.js';
import { recordDecision } from '../domain/decisions.js';

interface DecisionBody {
  decision?: string;
  note?: string;
  expected_version?: unknown;
  expected_payload_hash?: unknown;
}

export async function createDecision(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireRequestedFrom(c);
  requireCsrf(c);

  const requestId = pathUuid(c, 'id');
  const input = await jsonBody<DecisionBody>(c);
  if (input.decision !== 'approve' && input.decision !== 'decline') {
    throw new RouteError('decision must be "approve" or "decline"', 'bad_decision', 422);
  }
  const decision: Decision = input.decision;
  const note = typeof input.note === 'string' && input.note.trim().length > 0 ? input.note.slice(0, 4000) : null;

  const outcome = await inWorkspace(c, async (work) => {
    if (work.role !== 'admin') {
      const finance = await work.tx.query(
        `SELECT 1
           FROM requests r
           JOIN request_audiences ra ON ra.workspace_id=r.workspace_id AND ra.request_id=r.id
           JOIN members m ON m.workspace_id=r.workspace_id AND m.user_id=ra.user_id
          WHERE r.workspace_id=$1 AND r.id=$2 AND r.kind='invoice'
            AND r.payload ? 'workflow_provenance'
            AND ra.user_id=$3 AND 'finance'=ANY(m.reviewer_roles) AND m.status='active'`,
        [work.workspaceId, requestId, work.userId],
      );
      if (!finance.rows[0]) work.requireAdmin('recording a decision');
    }
    requireStepUp(work.session);
    return recordDecision(work, requestId, decision, note, input);
  });

  const body = decisionResultSchema.parse({
    decision_id: outcome.decision_id,
    request_id: outcome.request_id,
    resulting_status: outcome.resulting_status,
    effect_ids: outcome.effect_ids,
  });

  return c.json(body, outcome.conflict ? 200 : 201, {
    'X-Hermes-Conflict': outcome.conflict ? 'true' : 'false',
  });
}
