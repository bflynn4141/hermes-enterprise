// The enums the whole product agrees on. They are exported as `const` tuples so
// that the zod schemas, the TypeScript unions and the SQL CHECK constraints all
// come from one list; the SQL is generated from these names by hand today and a
// migration test asserts the database agrees (see apps/worker/test/db).
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** What a request is about. Each kind has its own terminal statuses. */
export const REQUEST_KINDS = ['application', 'invoice', 'agreement'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/**
 * Request lifecycle. `pending` is the only status a decision may act on; the
 * demo's rule that an opposite decision on a resolved request is ignored is
 * enforced here by the status transition table rather than by the caller.
 */
export const REQUEST_STATUSES = ['pending', 'admitted', 'declined', 'created', 'drafted', 'withdrawn'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** The human verdict. Kind plus decision determines the resulting status. */
export const DECISIONS = ['approve', 'decline'] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * Kind x decision -> resulting request status. Copied from the demo's
 * `decide()` so the product cannot drift from the behaviour the prototype
 * demonstrated: an approved application is `admitted`, an approved invoice is
 * `created`, an approved agreement is `drafted`, and nothing is ever sent,
 * paid or signed by this table.
 */
export const RESULTING_STATUS: Readonly<Record<RequestKind, Readonly<Record<Decision, RequestStatus>>>> = {
  application: { approve: 'admitted', decline: 'declined' },
  invoice: { approve: 'created', decline: 'declined' },
  agreement: { approve: 'drafted', decline: 'declined' },
};

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * An effect is the row that records a side effect a decision *implies*. It is
 * never executed as a consequence of the decision: the decision commits, the
 * effect sits in `pending`, and a human with the required role executes it.
 * In the pilot every execution returns `unavailable`; no outreach, payment or
 * signature code exists in this repository.
 */
export const EFFECT_KINDS = ['access_grant', 'email_send', 'payment', 'signature'] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const EFFECT_STATUSES = ['pending', 'assigned', 'executed', 'cancelled', 'unavailable', 'failed'] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

/** Reviewer roles that gate an effect. A member can hold several. */
export const REVIEWER_ROLES = ['access', 'finance', 'legal'] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

/** Which reviewer role each effect kind needs, and how many holders must act. */
export const EFFECT_REQUIREMENTS: Readonly<
  Record<EffectKind, { readonly requiredRole: ReviewerRole | 'admin'; readonly approvals: number }>
> = {
  access_grant: { requiredRole: 'access', approvals: 1 },
  email_send: { requiredRole: 'admin', approvals: 1 },
  signature: { requiredRole: 'admin', approvals: 1 },
  payment: { requiredRole: 'finance', approvals: 2 },
};

// ---------------------------------------------------------------------------
// Workspace membership
// ---------------------------------------------------------------------------

export const MEMBER_ROLES = ['admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const INVITATION_STATUSES = [
  'pending',
  'accepted',
  'expired',
  'withdrawn',
  'bounced',
  'resent',
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Runs and sessions
// ---------------------------------------------------------------------------

export const SESSION_MODES = ['ask', 'plan', 'work'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const RUN_STATUSES = ['working', 'waiting', 'stopping', 'stopped', 'error', 'completed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** A run in one of these statuses is live: the partial unique index uses it. */
export const ACTIVE_RUN_STATUSES = ['working', 'waiting', 'stopping'] as const;

export const RUN_STEP_STATES = ['todo', 'active', 'done', 'failed'] as const;
export type RunStepState = (typeof RUN_STEP_STATES)[number];

export const RUN_QUEUE_STATUSES = ['queued', 'paused', 'sent', 'removed'] as const;
export type RunQueueStatus = (typeof RUN_QUEUE_STATUSES)[number];

export const MESSAGE_ROLES = ['user', 'iris', 'human', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_STATUSES = ['streaming', 'complete', 'incomplete'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Error taxonomy. Revision 4 adds `auth`: a provider 401, which is permanent
 * because retrying with the same rejected key cannot succeed.
 */
export const ERROR_CLASSES = ['transient', 'permanent', 'auth', 'policy', 'cancelled'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Who acted. The nightly query asserts no `agent` actor ever wrote a decision. */
export const ACTOR_TYPES = ['user', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Audit event kinds. `events` stores ids and enum kinds only, never free text,
 * so that a data-subject erasure can tombstone the subject without destroying
 * the audit trail. Adding a kind is a migration plus a line here.
 */
export const EVENT_KINDS = [
  'decision.recorded',
  'request.created',
  'effect.assigned',
  'effect.executed',
  'effect.cancelled',
  'document.created',
  'document.versioned',
  'member.invited',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'instruction.saved',
  'instruction.proposed',
  'context.set',
  'settings.changed',
  'session.shared',
  'session.unshared',
  'provider_key.added',
  'provider_key.verified',
  'provider_key.revoked',
  'workspace.created',
  'workspace.deletion_scheduled',
  'subject.redacted',
  'run.errored',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// ---------------------------------------------------------------------------
// Jobs: every cross-system side effect after a commit
// ---------------------------------------------------------------------------

export const JOB_KINDS = [
  'publish',
  'receipt',
  'render',
  'extract',
  'reverify_key',
  'evict',
  'workos_sync',
  'token_cap_warning',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const jobKindSchema = z.enum(JOB_KINDS);
export const requestKindSchema = z.enum(REQUEST_KINDS);
export const requestStatusSchema = z.enum(REQUEST_STATUSES);
export const decisionSchema = z.enum(DECISIONS);
export const effectKindSchema = z.enum(EFFECT_KINDS);
export const effectStatusSchema = z.enum(EFFECT_STATUSES);
export const memberRoleSchema = z.enum(MEMBER_ROLES);
export const runStatusSchema = z.enum(RUN_STATUSES);
export const runStepStateSchema = z.enum(RUN_STEP_STATES);
export const errorClassSchema = z.enum(ERROR_CLASSES);
export const eventKindSchema = z.enum(EVENT_KINDS);
export const actorTypeSchema = z.enum(ACTOR_TYPES);
export const sessionModeSchema = z.enum(SESSION_MODES);
export const messageRoleSchema = z.enum(MESSAGE_ROLES);
export const messageStatusSchema = z.enum(MESSAGE_STATUSES);
