// Approval routing: who may approve each kind of work (roles-and-agents plan,
// piece 3; decision C93).
//
// Seven things a person approves in the Inbox. Three are decisions on a request
// an agent prepared (admit, approve an invoice draft, approve an agreement
// draft); four are actions that follow an approved request (pay, grant access,
// sign, send). For each, an Admin chooses who may approve (Admins, and any
// workspace roles), how many different people must (decisions too since C95),
// whether one of them must come from each named group, and whether the person
// whose agent prepared the request may approve it themself.
//
// Invoices and payments carry an amount, so their rule may have a second band
// above an amount (C94): "over 5,000.00 USD, Admins and Finance, one of each".
// `effectiveRule` is the one place that picks the band; a decision route or an
// effect never compares amounts itself.
//
// A workspace with no saved rule gets the default, which is exactly what the
// product enforced before this screen existed. Approval requests raised by
// workflows (outreach drafts, record changes, Shared Intelligence) keep their
// own reviewers; `WORKFLOW_APPROVALS` at the end of this file lists them so the
// screen can show them read-only (decision C97).
import { z } from 'zod';
import { roleSlugSchema } from './roles.js';

export const APPROVAL_ROUTE_KEYS = ['application', 'invoice', 'agreement', 'payment', 'access_grant', 'signature', 'email_send'] as const;
export type ApprovalRouteKey = (typeof APPROVAL_ROUTE_KEYS)[number];
export const approvalRouteKeySchema = z.enum(APPROVAL_ROUTE_KEYS);

/** A decision closes a request; an action is carried out after one is approved. */
export type ApprovalRouteKind = 'decision' | 'action';

export interface ApprovalRouteRule {
  readonly admins: boolean;
  readonly roles: readonly string[];
  readonly approvals_required: number;
  readonly allow_requester: boolean;
  /** With two or more people, at least one must come from each named group (Admins counts as a group). */
  readonly one_from_each: boolean;
}

/** A second rule for amounts strictly greater than `over_minor` in `currency`. */
export interface ApprovalThreshold {
  readonly over_minor: number;
  readonly currency: string;
  readonly rule: ApprovalRouteRule;
}

export interface ApprovalRouteDefinition {
  readonly key: ApprovalRouteKey;
  readonly kind: ApprovalRouteKind;
  readonly label: string;
  readonly description: string;
  /** A rule the workflow adds on top, shown so the screen never hides one. */
  readonly workflow_note: string | null;
  /** True when the work carries an amount (an invoice's total), so a threshold may apply. */
  readonly amount: boolean;
  readonly default: ApprovalRouteRule;
}

/** The catalog, in the order the screen lists it. Defaults match the product before C93. */
export const APPROVAL_ROUTES: readonly ApprovalRouteDefinition[] = [
  {
    key: 'application', kind: 'decision', label: 'Admit a partner applicant',
    description: 'Accept or decline a partner application an agent screened.',
    amount: false,
    workflow_note: null,
    default: { admins: true, roles: [], approvals_required: 1, allow_requester: true, one_from_each: false },
  },
  {
    key: 'invoice', kind: 'decision', label: 'Approve an invoice draft',
    description: 'Save the invoice to the Library. Nothing is paid or sent yet.',
    amount: true,
    workflow_note: 'Invoices handed over from Partnerships also go to the Finance person on that handoff.',
    default: { admins: true, roles: [], approvals_required: 1, allow_requester: true, one_from_each: false },
  },
  {
    key: 'agreement', kind: 'decision', label: 'Approve an agreement draft',
    description: 'Save the agreement to the Library. Nothing is signed or sent yet.',
    amount: false,
    workflow_note: 'Contractor agreements created when a partner is admitted also go to the Finance person on that handoff.',
    default: { admins: true, roles: [], approvals_required: 1, allow_requester: true, one_from_each: false },
  },
  {
    key: 'payment', kind: 'action', label: 'Pay an approved invoice',
    description: 'Release payment for an invoice that has been approved.',
    amount: true,
    workflow_note: null,
    default: { admins: false, roles: ['finance'], approvals_required: 2, allow_requester: true, one_from_each: false },
  },
  {
    key: 'access_grant', kind: 'action', label: 'Grant access to an admitted partner',
    description: 'Give a partner the access their admission promised.',
    amount: false,
    workflow_note: null,
    default: { admins: false, roles: ['access'], approvals_required: 1, allow_requester: true, one_from_each: false },
  },
  {
    key: 'signature', kind: 'action', label: 'Sign an approved agreement',
    description: 'Sign on behalf of the workspace.',
    amount: false,
    workflow_note: null,
    default: { admins: true, roles: [], approvals_required: 1, allow_requester: true, one_from_each: false },
  },
  {
    key: 'email_send', kind: 'action', label: 'Send an approved document',
    description: 'Email an approved invoice or agreement to the other party.',
    amount: false,
    workflow_note: null,
    default: { admins: true, roles: [], approvals_required: 1, allow_requester: true, one_from_each: false },
  },
];

export const approvalRouteDefinition = (key: ApprovalRouteKey): ApprovalRouteDefinition =>
  APPROVAL_ROUTES.find((route) => route.key === key)!;

/** Decisions and actions alike may need up to five different people (C95). */
export const MAX_APPROVALS = 5;
/** @deprecated Decisions may need several people too since C95; use MAX_APPROVALS. */
export const MAX_ACTION_APPROVALS = MAX_APPROVALS;
/** The largest threshold an Admin may set, in minor units (10,000,000.00). */
export const MAX_THRESHOLD_MINOR = 1_000_000_000;

export const approvalRouteRuleSchema = z.object({
  admins: z.boolean(),
  roles: z.array(roleSlugSchema).max(16),
  approvals_required: z.number().int().min(1).max(MAX_APPROVALS),
  /** Decisions: may the person whose agent prepared it decide it. Actions: may the person who approved the request also carry it out. */
  allow_requester: z.boolean(),
  /** Defaults to false so a client written before C95 still saves the rule it means. */
  one_from_each: z.boolean().default(false),
}).strict();

export const approvalThresholdSchema = z.object({
  /** "Over" is strictly greater than this many minor units. */
  over_minor: z.number().int().min(1).max(MAX_THRESHOLD_MINOR),
  currency: z.string().regex(/^[A-Z]{3}$/),
  rule: approvalRouteRuleSchema,
}).strict();

export const approvalRouteSchema = z.object({
  key: approvalRouteKeySchema,
  kind: z.enum(['decision', 'action']),
  label: z.string().max(120),
  description: z.string().max(300),
  workflow_note: z.string().max(300).nullable(),
  /** True for invoices and payments: the only routes a threshold may apply to. */
  amount: z.boolean(),
  rule: approvalRouteRuleSchema,
  /** The rule above an amount, or null when every amount uses `rule`. */
  threshold: approvalThresholdSchema.nullable(),
  /** True when no Admin has changed this rule. */
  is_default: z.boolean(),
  updated_at: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type ApprovalRoute = z.infer<typeof approvalRouteSchema>;

export const approvalRouteListSchema = z.object({ items: z.array(approvalRouteSchema).max(APPROVAL_ROUTE_KEYS.length) }).strict();
export type ApprovalRouteList = z.infer<typeof approvalRouteListSchema>;

/**
 * PUT /w/:ws/approval-routes/:key: the base rule, plus the band above an
 * amount. `threshold: null` removes the band; leaving it out keeps it as saved
 * would be ambiguous, so the route treats a missing threshold as null too.
 */
export const approvalRouteUpdateSchema = approvalRouteRuleSchema.extend({
  threshold: approvalThresholdSchema.nullable().optional(),
});
export type ApprovalRouteUpdate = z.input<typeof approvalRouteUpdateSchema>;

/** Returned with 202 when an approval is recorded but the decision needs more people. */
export const decisionPendingSchema = z.object({
  status: z.literal('pending'),
  confirmations: z.object({
    required: z.number().int().min(2).max(MAX_APPROVALS),
    recorded: z.number().int().min(0).max(MAX_APPROVALS),
    by_viewer: z.literal(true),
  }).strict(),
}).strict();
export type DecisionPending = z.infer<typeof decisionPendingSchema>;

/**
 * Why a rule cannot be saved, beyond its shape. The route and the mock refuse
 * with these reasons in this order.
 */
export function ruleProblem(rule: ApprovalRouteRule): 'no_approver' | 'one_from_each_needs_groups' | null {
  if (!rule.admins && rule.roles.length === 0) return 'no_approver';
  if (rule.one_from_each && (rule.approvals_required < 2 || groupsOf(rule).length < 2)) return 'one_from_each_needs_groups';
  return null;
}

/** The named groups a rule lets approve: `admins`, then `role:<slug>` per role. */
export function groupsOf(rule: Pick<ApprovalRouteRule, 'admins' | 'roles'>): string[] {
  return [...(rule.admins ? ['admins'] : []), ...[...new Set(rule.roles)].map((slug) => `role:${slug}`)];
}

/** Whether a person belongs to one group from `groupsOf`. */
export function inGroup(group: string, person: { role: string; reviewer_roles: readonly string[] }): boolean {
  return group === 'admins' ? person.role === 'admin' : person.reviewer_roles.includes(group.slice('role:'.length));
}

export type RuleBand = 'base' | 'over';

/**
 * The rule that applies to one piece of work. No threshold, or no amount,
 * means the base rule. An amount in another currency than the threshold's
 * takes the stricter band: without exchange rates the product cannot tell
 * whether it is over, so it fails closed. Otherwise "over" is strictly greater.
 */
export function effectiveRule(
  route: { rule: ApprovalRouteRule; threshold: ApprovalThreshold | null },
  amount: { minor: number; currency: string } | null,
): { rule: ApprovalRouteRule; band: RuleBand; reason: 'over_threshold' | 'other_currency' | null } {
  const threshold = route.threshold;
  if (!threshold || !amount) return { rule: route.rule, band: 'base', reason: null };
  if (amount.currency !== threshold.currency) return { rule: threshold.rule, band: 'over', reason: 'other_currency' };
  if (amount.minor > threshold.over_minor) return { rule: threshold.rule, band: 'over', reason: 'over_threshold' };
  return { rule: route.rule, band: 'base', reason: null };
}

/** "5,000.00 USD": the same text on the server's labels and the Admin screen. */
export function formatThresholdAmount(minor: number, currency: string): string {
  const major = (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${major} ${currency}`;
}

const joinWith = (items: readonly string[], last: string): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`;

/**
 * A rule in short phrases: ["Finance", "2 different people"], or
 * ["Admins and Finance", "one of each"]. The server's labels join them with a
 * comma, the Admin list with a middle dot.
 */
export function approverParts(rule: Pick<ApprovalRouteRule, 'admins' | 'roles' | 'approvals_required' | 'one_from_each'>, roleNames: ReadonlyMap<string, string>): string[] {
  const groups = [...(rule.admins ? ['Admins'] : []), ...rule.roles.map((slug) => roleNames.get(slug) ?? slug)];
  if (groups.length === 0) return ['Nobody'];
  const count = rule.approvals_required;
  if (rule.one_from_each && count >= 2 && groups.length >= 2) {
    return [joinWith(groups, 'and'), count > groups.length ? `${count} different people with one of each` : 'one of each'];
  }
  return count > 1 ? [joinWith(groups, 'or'), `${count} different people`] : [joinWith(groups, 'or')];
}

/**
 * Who approves, as one short label: "Finance", "Admins or Legal",
 * "Finance, 2 different people", "Admins and Finance, one of each". A rule for
 * one Admin keeps the label it always had, "Workspace Admin".
 */
export function approverLabel(rule: Pick<ApprovalRouteRule, 'admins' | 'roles' | 'approvals_required' | 'one_from_each'>, roleNames: ReadonlyMap<string, string>): string {
  if (rule.admins && rule.roles.length === 0 && rule.approvals_required === 1) return 'Workspace Admin';
  return approverParts(rule, roleNames).join(', ');
}

/** " (over 5,000.00 USD)" or " (amounts not in USD)" after a label, when the band applies. */
export function bandSuffix(threshold: Pick<ApprovalThreshold, 'over_minor' | 'currency'> | null, reason: 'over_threshold' | 'other_currency' | null): string {
  if (!threshold || !reason) return '';
  return reason === 'other_currency'
    ? ` (amounts not in ${threshold.currency})`
    : ` (over ${formatThresholdAmount(threshold.over_minor, threshold.currency)})`;
}

/** Whether a person with this workspace role and these role slugs may approve under a rule. */
export function mayApprove(rule: Pick<ApprovalRouteRule, 'admins' | 'roles'>, person: { role: string; reviewer_roles: readonly string[] }): boolean {
  return (rule.admins && person.role === 'admin') || rule.roles.some((slug) => person.reviewer_roles.includes(slug));
}

/** The routes a person may approve at some amount, for "Can approve" summaries on member screens. */
export function approvalsFor<T extends Pick<ApprovalRoute, 'key' | 'label' | 'rule'> & { threshold?: ApprovalThreshold | null }>(routes: readonly T[], person: { role: string; reviewer_roles: readonly string[] }): T[] {
  return routes.filter((route) => mayApprove(route.rule, person) || (route.threshold ? mayApprove(route.threshold.rule, person) : false));
}

/**
 * Approvals a workflow raises with its own reviewer, which an Admin cannot
 * route yet (decision C97). The Approvals screen lists them read-only so it
 * never hides who reviews something. Each reviewer is written in plain words
 * from the code that sets it:
 * - outreach: `partner-screening/automation.ts`, the agent owner's member row;
 * - first search: `domain/member-agent-coordination.ts`, the joining member;
 * - engagement records: `partner-workflow/service.ts`, the Finance principal;
 * - Shared Intelligence: `shared-intelligence/service.ts`, an Admin other than
 *   the proposer first, then a Shared Intelligence reviewer.
 */
export interface WorkflowApproval {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly reviewer: string;
}

export const WORKFLOW_APPROVALS: readonly WorkflowApproval[] = [
  {
    key: 'partner_outreach',
    label: 'Partner outreach email',
    description: 'An email an agent wrote to a partner, before it is saved as a draft or sent.',
    reviewer: 'the person the agent works for',
  },
  {
    key: 'first_search',
    label: 'A new member’s first search',
    description: 'The first capped partner search a new member’s agent runs.',
    reviewer: 'the new member',
  },
  {
    key: 'partner_engagement_record',
    label: 'Partner engagement record changes',
    description: 'Changes to an admitted partner’s engagement terms before Finance relies on them.',
    reviewer: 'the Finance person on the handoff',
  },
  {
    key: 'shared_intelligence',
    label: 'Shared Intelligence publication',
    description: 'Sharing what one team’s agent learned with other teams.',
    reviewer: 'another Admin, or a Shared Intelligence reviewer if there is no other Admin',
  },
];
