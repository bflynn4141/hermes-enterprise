import { approvalPayloadSchema, type ApprovalListProjection, type RequestDecisionSummary } from '@hermes/shared';
import type { RequestRow } from './requests.js';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const clip = (value: string, max = 280): string => value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
const date = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
};
const money = (minor: number, currency: string): string => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);

type Fact = RequestDecisionSummary['facts'][number];
const fact = (label: string, value: string | number, emphasis: Fact['emphasis'] = 'default'): Fact =>
  ({ label, value: clip(String(value), 200), emphasis });

function approvalSummary(row: RequestRow, approval: ApprovalListProjection): RequestDecisionSummary | null {
  const parsed = approvalPayloadSchema.safeParse(row.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  let action = 'Review approval';
  let primary = payload.summary;
  let facts: Fact[] = [];

  switch (payload.approval_type) {
    case 'run_plan':
      action = 'Approve run plan';
      primary = `Run ${payload.details.steps.length} steps to ${clip(payload.details.goal, 210)}`;
      facts = [
        fact('Budget cap', money(payload.details.budget.cap_minor, payload.details.budget.currency), 'risk'),
        fact('Calls', payload.details.budget.call_cap),
        fact('Schedule', payload.details.schedule),
      ];
      break;
    case 'team_commitment':
      action = 'Approve team commitment';
      primary = clip(payload.details.workload);
      facts = [fact('Due', date(payload.details.due_at), 'attention'), fact('Criteria', payload.details.acceptance_criteria.length), fact('Dependencies', payload.details.dependencies.length)];
      break;
    case 'access':
      action = 'Approve access';
      primary = `${payload.details.operations.join(', ')} access to ${payload.details.resource_label}`;
      facts = [fact('Operations', payload.details.operations.join(', '), payload.details.operations.includes('admin') ? 'risk' : 'default'), fact('Expires', date(payload.details.access_expires_at), 'attention'), fact('Purpose', payload.details.purpose)];
      break;
    case 'communication':
      action = payload.details.draft_only ? 'Approve email draft' : 'Approve communication';
      primary = `${payload.details.draft_only ? 'Draft' : 'Send'} ${payload.details.channel} to ${payload.details.recipients.length} recipient${payload.details.recipients.length === 1 ? '' : 's'}${payload.details.subject ? `: ${payload.details.subject}` : ''}`;
      facts = [fact('Recipients', payload.details.recipients.length), fact('Attachments', payload.details.attachments.length), ...(payload.details.scheduled_for ? [fact('Scheduled', date(payload.details.scheduled_for), 'attention')] : [])];
      break;
    case 'shared_learning':
      action = 'Approve shared learning';
      primary = `Publish ${payload.details.title} as ${payload.details.proposed_version}`;
      facts = [fact('Current', payload.details.current_version ?? 'New skill'), fact('Audience', payload.details.reuse_audience.length), fact('Private exclusions', payload.details.excluded_private_data.length, 'attention')];
      break;
    case 'deliverable':
      action = 'Approve deliverable';
      primary = `${payload.details.title} · ${payload.details.version}`;
      facts = [fact('Evidence', payload.details.evidence_ids.length), fact('Missing information', payload.details.missing_information.length, payload.details.missing_information.length ? 'attention' : 'default'), fact('Releases', payload.details.releases_dependent_request_ids.length)];
      break;
    case 'data_disclosure':
      action = 'Approve data disclosure';
      primary = `Share ${payload.details.items.length} resource${payload.details.items.length === 1 ? '' : 's'} with ${payload.details.recipient.organization}`;
      facts = [fact('Fields', payload.details.items.reduce((sum, item) => sum + item.fields.length, 0), 'risk'), fact('Redactions', payload.details.redactions.length), fact('Retain until', date(payload.details.retention_until), 'attention')];
      break;
    case 'record_change':
      action = 'Approve record changes';
      primary = `Change ${payload.details.changes.length} field${payload.details.changes.length === 1 ? '' : 's'} in ${payload.details.system_label}`;
      facts = [fact('Records', new Set(payload.details.changes.map((change) => change.record_id)).size), fact('Validation checks', payload.details.validation.length), fact('Rollback', payload.details.rollback)];
      break;
    case 'exception':
      action = 'Approve exception';
      primary = `Temporary exception to ${payload.details.rule_label}`;
      facts = [fact('Expires', date(payload.details.exception_expires_at), 'attention'), fact('Controls', payload.details.compensating_controls.length), fact('Scope', payload.details.scope, 'risk')];
      break;
    case 'agent_governance':
      action = 'Approve agent changes';
      primary = `Change agent schedule, tools, or settings`;
      facts = [fact('Tools', `${payload.details.current_tools.length} → ${payload.details.proposed_tools.length}`), fact('Settings', payload.details.setting_changes.length), fact('Permissions affected', payload.details.affected_permissions.length, payload.details.affected_permissions.length ? 'risk' : 'default')];
      break;
  }

  return {
    action,
    primary: clip(primary),
    facts: facts.slice(0, 4),
    consequence: clip(payload.consequence, 500),
    approval_requirement: {
      mode: approval.mode,
      completed_steps: approval.completed_steps,
      total_steps: approval.total_steps,
      remaining_approvals: approval.remaining_approvals,
      current: approval.current_steps,
      pending_for_viewer: approval.pending_for_viewer,
      waiting_on_others: approval.waiting_on_others,
      expires_at: approval.expires_at,
    },
  };
}

export function decisionSummary(row: RequestRow, approval: ApprovalListProjection | null): RequestDecisionSummary {
  if (row.kind === 'approval' && approval) {
    const summary = approvalSummary(row, approval);
    if (summary) return summary;
  }
  const payload = record(row.payload);
  const single = {
    mode: 'single' as const,
    completed_steps: row.status === 'pending' ? 0 : 1,
    total_steps: 1,
    remaining_approvals: row.status === 'pending' ? 1 : 0,
    current: row.status === 'pending' ? [{ label: 'Human review', approvals_recorded: 0, quorum: 1 }] : [],
    pending_for_viewer: row.status === 'pending',
    waiting_on_others: false,
    expires_at: null,
  };
  if (row.kind === 'application') {
    const score = typeof payload.score === 'number' ? payload.score : null;
    const maximum = typeof payload.score_max === 'number' ? payload.score_max : 100;
    return { action: 'Review applicant', primary: clip(text(payload.proposed_role) ?? text(payload.role) ?? 'Partner program application'), facts: [...(score === null ? [] : [fact('Evidence score', `${score}/${maximum}`)]), fact('Sources', Array.isArray(payload.sources) ? payload.sources.length : 0), fact('Missing', Array.isArray(payload.missing) ? payload.missing.length : 0, Array.isArray(payload.missing) && payload.missing.length ? 'attention' : 'default')], consequence: null, approval_requirement: single };
  }
  if (row.kind === 'invoice') {
    const payer = text(record(payload.payer).name) ?? text(record(payload.payee).name) ?? row.label;
    const total = typeof payload.total_minor === 'number' ? payload.total_minor : null;
    return { action: 'Review invoice', primary: `Approve invoice for ${payer}`, facts: [...(total === null ? [] : [fact('Total', money(total, text(payload.currency) ?? 'USD'), 'risk')]), ...(text(payload.due_at) ? [fact('Due', date(text(payload.due_at)!), 'attention')] : [])], consequence: null, approval_requirement: single };
  }
  if (row.kind === 'agreement') {
    return { action: 'Review agreement', primary: clip(text(payload.title) ?? text(payload.number) ?? row.label), facts: [fact('Version', text(payload.version_label) ?? 'Unsigned'), fact('Parties', Array.isArray(payload.parties) ? payload.parties.length : 0)], consequence: null, approval_requirement: single };
  }
  return { action: row.kind === 'task' ? 'Continue setup' : 'Review request', primary: clip(text(payload.description) ?? row.label), facts: [], consequence: null, approval_requirement: single };
}
