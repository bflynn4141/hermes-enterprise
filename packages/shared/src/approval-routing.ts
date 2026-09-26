// Approval routing: who may approve each kind of work (roles-and-agents plan,
// piece 3; decision C93).
//
// Seven things a person approves in the Inbox. Three are decisions on a request
// an agent prepared (admit, approve an invoice draft, approve an agreement
// draft); four are actions that follow an approved request (pay, grant access,
// sign, send). For each, an Admin chooses who may approve (Admins, and any
// workspace roles), how many different people must, and whether the person
// whose agent prepared the request may approve it themself.
//
// A workspace with no saved rule gets the default, which is exactly what the
// product enforced before this screen existed. Approval requests raised by
// workflows (outreach drafts, record changes, Shared Intelligence) keep their
// own reviewers; they are not on this list yet.
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
}

export interface ApprovalRouteDefinition {
  readonly key: ApprovalRouteKey;
  readonly kind: ApprovalRouteKind;
  readonly label: string;
  readonly description: string;
  /** A rule the workflow adds on top, shown so the screen never hides one. */
  readonly workflow_note: string | null;
  readonly default: ApprovalRouteRule;
}

/** The catalog, in the order the screen lists it. Defaults match the product before C93. */
export const APPROVAL_ROUTES: readonly ApprovalRouteDefinition[] = [
  {
    key: 'application', kind: 'decision', label: 'Admit a partner applicant',
    description: 'Accept or decline a partner application an agent screened.',
    workflow_note: null,
    default: { admins: true, roles: [], approvals_required: 1, allow_requester: true },
  },
  {
    key: 'invoice', kind: 'decision', label: 'Approve an invoice draft',
    description: 'Save the invoice to the Library. Nothing is paid or sent yet.',
    workflow_note: 'Invoices handed over from Partnerships also go to the Finance person on that handoff.',
    default: { admins: true, roles: [], approvals_required: 1, allow_requester: true },
  },
  {
    key: 'agreement', kind: 'decision', label: 'Approve an agreement draft',
    description: 'Save the agreement to the Library. Nothing is signed or sent yet.',
    workflow_note: 'Contractor agreements created when a partner is admitted also go to the Finance person on that handoff.',
    default: { admins: true, roles: [], approvals_required: 1, allow_requester: true },
  },
  {
    key: 'payment', kind: 'action', label: 'Pay an approved invoice',
    description: 'Release payment for an invoice that has been approved.',
    workflow_note: null,
    default: { admins: false, roles: ['finance'], approvals_required: 2, allow_requester: true },
  },
  {
    key: 'access_grant', kind: 'action', label: 'Grant access to an admitted partner',
    description: 'Give a partner the access their admission promised.',
    workflow_note: null,
    default: { admins: false, roles: ['access'], approvals_required: 1, allow_requester: true },
  },
  {
    key: 'signature', kind: 'action', label: 'Sign an approved agreement',
    description: 'Sign on behalf of the workspace.',
    workflow_note: null,
    default: { admins: true, roles: [], approvals_required: 1, allow_requester: true },
  },
  {
    key: 'email_send', kind: 'action', label: 'Send an approved document',
    description: 'Email an approved invoice or agreement to the other party.',
    workflow_note: null,
    default: { admins: true, roles: [], approvals_required: 1, allow_requester: true },
  },
];

export const approvalRouteDefinition = (key: ApprovalRouteKey): ApprovalRouteDefinition =>
  APPROVAL_ROUTES.find((route) => route.key === key)!;

/** Decisions are one person's call in this version; actions may need several. */
export const MAX_ACTION_APPROVALS = 5;

export const approvalRouteRuleSchema = z.object({
  admins: z.boolean(),
  roles: z.array(roleSlugSchema).max(16),
  approvals_required: z.number().int().min(1).max(MAX_ACTION_APPROVALS),
  /** Decisions: may the person whose agent prepared it decide it. Actions: may the person who approved the request also carry it out. */
  allow_requester: z.boolean(),
}).strict();

export const approvalRouteSchema = z.object({
  key: approvalRouteKeySchema,
  kind: z.enum(['decision', 'action']),
  label: z.string().max(120),
  description: z.string().max(300),
  workflow_note: z.string().max(300).nullable(),
  rule: approvalRouteRuleSchema,
  /** True when no Admin has changed this rule. */
  is_default: z.boolean(),
  updated_at: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type ApprovalRoute = z.infer<typeof approvalRouteSchema>;

export const approvalRouteListSchema = z.object({ items: z.array(approvalRouteSchema).max(APPROVAL_ROUTE_KEYS.length) }).strict();
export type ApprovalRouteList = z.infer<typeof approvalRouteListSchema>;

/** PUT /w/:ws/approval-routes/:key. Someone must be able to approve, and a decision takes one person. */
export const approvalRouteUpdateSchema = approvalRouteRuleSchema;
export type ApprovalRouteUpdate = z.infer<typeof approvalRouteUpdateSchema>;

/** Whether a person with this workspace role and these role slugs may approve under a rule. */
export function mayApprove(rule: Pick<ApprovalRouteRule, 'admins' | 'roles'>, person: { role: string; reviewer_roles: readonly string[] }): boolean {
  return (rule.admins && person.role === 'admin') || rule.roles.some((slug) => person.reviewer_roles.includes(slug));
}

/** The routes a person may approve, for "Can approve" summaries on member screens. */
export function approvalsFor(routes: readonly Pick<ApprovalRoute, 'key' | 'label' | 'rule'>[], person: { role: string; reviewer_roles: readonly string[] }) {
  return routes.filter((route) => mayApprove(route.rule, person));
}
