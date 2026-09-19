// Request audiences are the content-visibility boundary for human reads.
//
// Most historical requests have no audience rows and remain visible to every
// active workspace member. Once a request has at least one audience row, only
// those exact human principals may read the request or anything derived from
// it. Workspace Admin is setup authority; it is deliberately not an override.
import type { Tx } from '../db/client.js';
import type { HubEvent } from '../hubs.js';

/** SQL predicate for a request id expression and a bound human user id. */
export function requestAudiencePredicate(requestIdSql: string, userParameterSql: string): string {
  return `(NOT EXISTS (
    SELECT 1 FROM request_audiences audience_any
     WHERE audience_any.request_id = ${requestIdSql}
  ) OR EXISTS (
    SELECT 1 FROM request_audiences audience_me
     WHERE audience_me.request_id = ${requestIdSql}
       AND audience_me.user_id = ${userParameterSql}
  ))`;
}

/** Generic agent reads have no named human principal and may read legacy rows only. */
export function unscopedRequestPredicate(requestIdSql: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM request_audiences audience_any
     WHERE audience_any.request_id = ${requestIdSql}
  )`;
}

/**
 * Resolve the request named by a workspace stream event, as text.
 *
 * The casts stay on table ids rather than untrusted JSON payload values. A
 * malformed historical payload therefore asks the client to resync instead of
 * turning the visibility query itself into a 500.
 */
export function streamEventRequestIdSql(eventAlias: string): string {
  return `(CASE
    WHEN ${eventAlias}.kind IN ('request.created', 'decision.recorded')
      THEN ${eventAlias}.payload->>'request_id'
    WHEN ${eventAlias}.kind = 'entity.updated'
      AND ${eventAlias}.payload->>'entity_type' = 'request'
      THEN ${eventAlias}.payload->>'entity_id'
    WHEN ${eventAlias}.kind = 'entity.updated'
      AND ${eventAlias}.payload->>'entity_type' = 'document'
      THEN (SELECT document_scope.request_id::text FROM documents document_scope
             WHERE document_scope.id::text = ${eventAlias}.payload->>'entity_id')
    WHEN ${eventAlias}.kind = 'entity.updated'
      AND ${eventAlias}.payload->>'entity_type' = 'effect'
      THEN (SELECT effect_scope.request_id::text FROM effects effect_scope
             WHERE effect_scope.id::text = ${eventAlias}.payload->>'entity_id')
    WHEN ${eventAlias}.kind = 'member.agent_joined'
      THEN ${eventAlias}.payload->>'coordination_request_id'
    ELSE NULL
  END)`;
}

/** Visibility predicate for one workspace stream-event alias. */
export function streamEventAudiencePredicate(eventAlias: string, userParameterSql: string): string {
  const requestId = streamEventRequestIdSql(eventAlias);
  return `(NOT EXISTS (
    SELECT 1 FROM request_audiences stream_audience_any
     WHERE stream_audience_any.request_id::text = ${requestId}
  ) OR EXISTS (
    SELECT 1 FROM request_audiences stream_audience_me
     WHERE stream_audience_me.request_id::text = ${requestId}
       AND stream_audience_me.user_id = ${userParameterSql}
  ))`;
}

export interface AudienceScopedHubEvent extends HubEvent {
  /** Delivery-only metadata. The hub removes it before sending the event. */
  readonly audience_user_ids?: readonly string[];
}

/**
 * Add delivery-only audience metadata to committed workspace events.
 *
 * The durable stream row remains contract-shaped. Both the immediate publish
 * and retry paths call this after insertion, so a dropped response cannot turn
 * a private retry into workspace-wide fan-out.
 */
export async function scopeWorkspaceHubEvents(
  tx: Tx,
  events: readonly HubEvent[],
): Promise<AudienceScopedHubEvent[]> {
  const workspaceIds = events
    .filter((event) => event.session_id === null && /^\d{1,19}$/.test(event.id))
    .map((event) => event.id);
  if (workspaceIds.length === 0) return [...events];

  const eventRequestId = streamEventRequestIdSql('stream_scope');
  const { rows } = await tx.query<{
    id: string;
    has_audience: boolean;
    audience_user_ids: string[] | null;
  }>(
    `SELECT stream_scope.id::text AS id,
            EXISTS (
              SELECT 1
                FROM request_audiences stream_audience_any
               WHERE stream_audience_any.workspace_id = stream_scope.workspace_id
                 AND stream_audience_any.request_id::text = ${eventRequestId}
            ) AS has_audience,
            (SELECT array_agg(stream_audience.user_id::text ORDER BY stream_audience.user_id::text)
               FROM request_audiences stream_audience
               JOIN members active_member
                 ON active_member.workspace_id = stream_audience.workspace_id
                AND active_member.user_id = stream_audience.user_id
                AND active_member.status = 'active'
              WHERE stream_audience.workspace_id = stream_scope.workspace_id
                AND stream_audience.request_id::text = ${eventRequestId}) AS audience_user_ids
       FROM stream_events stream_scope
      WHERE stream_scope.id = ANY ($1::bigint[])`,
    [workspaceIds],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));

  return events.map((event) => {
    if (event.session_id !== null || !/^\d{1,19}$/.test(event.id)) return event;
    const scope = byId.get(event.id);
    // A numeric workspace event missing from the tenant-scoped query is not
    // safe to broadcast. Every legitimate caller just read or inserted the row
    // in this transaction, so absence means its scope could not be established.
    if (!scope) return { ...event, audience_user_ids: [] };
    if (!scope.has_audience) return event;
    // Keep an explicitly scoped request private even after its last viewer is
    // removed. Omitting the property here would turn an empty active audience
    // into the legacy workspace-public case in WorkspaceHub.maySee.
    return { ...event, audience_user_ids: scope.audience_user_ids ?? [] };
  });
}
