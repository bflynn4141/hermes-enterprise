import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type {
  ApprovalProposal,
  ApprovalView,
  RequestEntity,
} from '@hermes/shared';
import { useAdapter, useAppState, useDispatch } from '../store-context.js';
import { Glass, Icon } from '../ui/icons.js';
import { Avatar, Button, EmptyState, MenuItem, Popover, Skeleton } from '../ui/primitives.js';
import { LIST_KEYS } from '../selectors.js';
import { APPROVAL_META, approvalPrimaryAction, approvalDecisionPrompt, approvalEffectCopy, approvalEffectLabel, approvalStatusLabel, approvalWorkLabel, approvalWorkReason, approvalWorkStartedLine, decisionSignInStale } from '../approval-copy.js';
export { APPROVAL_META, approvalType, approvalTypeLabel, approvalActionLabel, approvalPrimaryAction, approvalIcon, approvalReviewerLabel, matchesReviewerFilter, approvalPreview } from '../approval-copy.js';
import './approval-review.css';
import { ApprovalEvidence } from './ApprovalEvidence.js';
export { ApprovalEvidence } from './ApprovalEvidence.js';
import { clearApprovalRevisionDraft, revisionDraftStorage, saveApprovalRevisionDraft, takeApprovalRevisionDraft, type ApprovalRevisionScope } from '../../model/approval-revision-draft.js';
import { RestError } from '../../model/rest.js';
import { InputProvenanceBadge } from '../input-provenance.js';

const shortDateTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const money = (minor: number, currency: string): string =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);

const displayValue = (value: string | number | boolean | null): string => {
  if (value === null) return 'Not set';
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
  return String(value);
};

function Fact({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="approval-fact">
      <span>{label}</span>
      <strong data-emphasis={strong ? 'true' : undefined}>{children}</strong>
    </div>
  );
}

function CheckList({ items, empty = 'None' }: { items: readonly string[]; empty?: string }) {
  if (items.length === 0) return <p className="meta">{empty}</p>;
  return (
    <ul className="approval-check-list">
      {items.map((item) => (
        <li key={item}><Icon name="check" size={15} /> <span>{item}</span></li>
      ))}
    </ul>
  );
}

function AgentIdentity({ name, email, label }: { name: string; email?: string | null; label?: string }) {
  return (
    <div className="approval-agent">
      <Glass name="iris" size={34} />
      <span className="col grow" style={{ gap: 2 }}>
        <strong>{name}</strong>
        <span className="meta">{[email, label].filter(Boolean).join(' · ')}</span>
      </span>
    </div>
  );
}

function RunPlanPreview({ view }: { view: ApprovalView }) {
  if (view.payload.approval_type !== 'run_plan') return null;
  const details = view.payload.details;
  const budget = details.budget;
  return (
    <div className="approval-preview approval-plan-preview">
      <section className="approval-lead-block">
        <span className="approval-kicker">Goal</span>
        <h2>{details.goal}</h2>
        <span className="meta">{details.schedule}</span>
      </section>
      <ol className="approval-plan-steps">
        {details.steps.map((step, index) => (
          <li key={step.id}>
            <span>{index + 1}</span>
            <div className="col grow" style={{ gap: 3 }}><strong>{step.label}</strong><span className="meta">{step.output}</span></div>
          </li>
        ))}
      </ol>
      <div className="approval-facts three">
        <Fact label="Estimated cost" strong>{money(budget.estimated_min_minor, budget.currency)}–{money(budget.estimated_max_minor, budget.currency)}</Fact>
        <Fact label="Hard cap" strong>{money(budget.cap_minor, budget.currency)}</Fact>
        <Fact label="Estimated tokens">{((budget.estimated_input_tokens ?? 0) + (budget.estimated_output_tokens ?? 0)).toLocaleString()}</Fact>
      </div>
      <div className="approval-facts four approval-enforcement-caps" aria-label="Enforced run limits">
        <Fact label="Total token cap" strong>{budget.total_token_cap.toLocaleString()}</Fact>
        <Fact label="Call cap" strong>{budget.call_cap.toLocaleString()}</Fact>
        <Fact label="Output / call" strong>{budget.max_output_tokens_per_call.toLocaleString()}</Fact>
        <Fact label="Parallel calls" strong>{budget.max_parallel_calls.toLocaleString()}</Fact>
      </div>
      <div className="approval-two-col">
        <section><span className="approval-kicker">Participating agents</span>{details.participating_agents.map((agent) => {
          const identity = [view.identities.requester_agent, ...view.identities.target_agents].find((item) => item.id === agent.agent_id);
          return <AgentIdentity key={agent.agent_id} name={identity?.name ?? 'Workspace agent'} email={identity?.email} label={agent.role} />;
        })}</section>
        <section><span className="approval-kicker">Outputs</span><CheckList items={details.deliverables} /></section>
      </div>
      <p className="meta">{budget.illustrative ? 'Illustrative estimate · ' : ''}Models: {budget.model_ids.join(', ') || 'configured model'} · Tools: {budget.metered_tools.join(', ') || 'none'} · {budget.retries_included} retries included</p>
    </div>
  );
}

function TeamCommitmentPreview({ view }: { view: ApprovalView }) {
  if (view.payload.approval_type !== 'team_commitment') return null;
  const details = view.payload.details;
  const requester = [view.identities.requester_agent, ...view.identities.target_agents].find((item) => item.id === details.requester_agent_id);
  const recipient = view.identities.target_agents.find((item) => item.id === details.recipient_agent_id);
  return (
    <div className="approval-preview">
      <div className="approval-handoff">
        <AgentIdentity name={requester?.name ?? 'Requesting agent'} email={requester?.email} label="Requester" />
        <Icon name="arrow" size={22} />
        <AgentIdentity name={recipient?.name ?? 'Receiving agent'} email={recipient?.email} label={recipient?.responsible_member_name ? `Responsible · ${recipient.responsible_member_name}` : 'Recipient'} />
      </div>
      <section className="approval-lead-block"><span className="approval-kicker">Bounded task</span><h2>{details.workload}</h2></section>
      <div className="approval-facts"><Fact label="Due">{shortDateTime(details.due_at)}</Fact><Fact label="Mandate">Receiving agent only</Fact></div>
      <div className="approval-two-col"><section><span className="approval-kicker">Dependencies</span><CheckList items={details.dependencies} /></section><section><span className="approval-kicker">Acceptance criteria</span><CheckList items={details.acceptance_criteria} /></section></div>
      {view.payload.context.source.trigger?.kind === 'member_agent_joined' && (
        <p className="approval-boundary-note">Approval records this proposed collaboration. No agent message or run is sent until a delivery executor exists.</p>
      )}
    </div>
  );
}

function AccessPreview({ view }: { view: ApprovalView }) {
  if (view.payload.approval_type !== 'access') return null;
  const details = view.payload.details;
  const agent = [view.identities.requester_agent, ...view.identities.target_agents].find((item) => item.id === details.requested_agent_id);
  const operations = new Set(details.operations);
  return (
    <div className="approval-preview">
      <div className="approval-resource"><Glass name="context" size={46} /><Icon name="arrow" /><div className="col grow"><h2>{details.resource_label}</h2><span className="meta">{details.resource_id}</span></div></div>
      <AgentIdentity name={agent?.name ?? 'Requested agent'} email={agent?.email} label="Access recipient" />
      <div className="approval-facts three">
        {(['read', 'write', 'admin'] as const).map((operation) => <Fact key={operation} label={operation[0]!.toUpperCase() + operation.slice(1)}><span className={operations.has(operation) ? 'approval-yes' : 'approval-no'}>{operations.has(operation) ? 'Allowed' : 'Not allowed'}</span></Fact>)}
      </div>
      <div className="approval-facts"><Fact label="Purpose">{details.purpose}</Fact><Fact label="Expires">{shortDateTime(details.access_expires_at)}</Fact></div>
    </div>
  );
}

function CommunicationPreview({ view }: { view: ApprovalView }) {
  if (view.payload.approval_type !== 'communication') return null;
  const details = view.payload.details;
  return (
    <div className="approval-preview">
      <article className="approval-message">
        <dl>
          <div><dt>From</dt><dd>{details.sender.address ?? 'Sender address not provided'}</dd></div>
          <div><dt>To</dt><dd>{details.recipients.map((item) => item.address ? `${item.name} <${item.address}>` : `${item.name} · email address needed`).join(', ')}</dd></div>
          {details.recipients.some((item) => item.phone_numbers?.length) && <div><dt>Phone</dt><dd>{details.recipients.flatMap((item) => item.phone_numbers ?? []).map((phone) => phone.type ? `${phone.number} · ${phone.type}` : phone.number).join(', ')}</dd></div>}
          {details.recipients.some((item) => item.social_profiles?.length) && <div><dt>Profiles</dt><dd>{details.recipients.flatMap((item) => item.social_profiles ?? []).map((profile) => <a key={`${profile.network}:${profile.url}`} href={profile.url} target="_blank" rel="noreferrer">{profile.network}</a>).reduce<ReactNode[]>((items, link, index) => index === 0 ? [link] : [...items, ', ', link], [])}</dd></div>}
          {details.subject && <div><dt>Subject</dt><dd>{details.subject}</dd></div>}
        </dl>
        <div className="approval-message-body">{details.body}</div>
        {details.attachments.length > 0 && <div className="approval-attachments">{details.attachments.map((item) => <span key={item.id}><Icon name="doc" size={15} /> {item.label}</span>)}</div>}
      </article>
      {!details.draft_only && details.scheduled_for && <p className="meta">Requested schedule · {shortDateTime(details.scheduled_for)}</p>}
    </div>
  );
}

function SharedLearningPreview({ view }: { view: ApprovalView }) {
  if (view.payload.approval_type !== 'shared_learning') return null;
  const details = view.payload.details;
  return (
    <div className="approval-preview">
      <section className="approval-lead-block"><span className="approval-kicker">{details.current_version ?? 'New'} → {details.proposed_version}</span><h2>{details.title}</h2></section>
      <pre className="approval-diff" aria-label="Skill changes">{details.diff}</pre>
      <div className="approval-two-col"><section><span className="approval-kicker">Reuse audience</span><CheckList items={details.reuse_audience} /></section><section><span className="approval-kicker">Private data excluded</span><CheckList items={details.excluded_private_data} /></section></div>
      <p className="meta">{details.source_evidence_ids.length} evidence reference{details.source_evidence_ids.length === 1 ? '' : 's'} · Publishing instructions does not publish the source data.</p>
    </div>
  );
}

function DeliverablePreview({ view }: { view: ApprovalView }) {
  if (view.payload.approval_type !== 'deliverable') return null;
  const details = view.payload.details;
  return (
    <div className="approval-preview">
      <article className="approval-artifact"><span className="approval-kicker">{details.version} · {details.artifact_id}</span><h2>{details.title}</h2><div>{details.content}</div></article>
      <div className="approval-two-col"><section><span className="approval-kicker">Evidence</span><CheckList items={details.evidence_ids} empty="No linked evidence" /></section><section><span className="approval-kicker">Missing information</span><CheckList items={details.missing_information} empty="Nothing marked missing" /></section></div>
      <p className="meta">{details.releases_dependent_request_ids.length} dependent request reference{details.releases_dependent_request_ids.length === 1 ? '' : 's'}.</p>
    </div>
  );
}

function DisclosurePreview({ view }: { view: ApprovalView }) {
  if (view.payload.approval_type !== 'data_disclosure') return null;
  const details = view.payload.details;
  return (
    <div className="approval-preview">
      <section className="approval-lead-block"><span className="approval-kicker">Recipient</span><h2>{details.recipient.organization}</h2><span className="meta">{details.recipient.contact ?? details.purpose}</span></section>
      <div className="approval-manifest">{details.items.map((item) => <div key={item.resource_id}><strong>{item.resource_id}</strong><span>{item.fields.join(', ')}</span></div>)}</div>
      <div className="approval-two-col"><section><span className="approval-kicker">Redactions</span><CheckList items={details.redactions} empty="No redactions specified" /></section><section><span className="approval-kicker">Retention</span><p>{shortDateTime(details.retention_until)}</p></section></div>
      <p className="meta">Purpose · {details.purpose}</p>
    </div>
  );
}

function RecordChangePreview({ view }: { view: ApprovalView }) {
  if (view.payload.approval_type !== 'record_change') return null;
  const details = view.payload.details;
  return (
    <div className="approval-preview">
      <section className="approval-lead-block"><span className="approval-kicker">{details.system_label}</span><h2>{details.changes.length} proposed change{details.changes.length === 1 ? '' : 's'}</h2></section>
      <div className="approval-change-table" role="table" aria-label="Record changes">
        <div role="row" className="head"><span>Record / field</span><span>Before</span><span>After</span></div>
        {details.changes.map((change) => <div role="row" key={`${change.record_id}:${change.field}`}><span><strong>{change.record_id}</strong><small>{change.field}</small></span><span>{displayValue(change.before)}</span><span>{displayValue(change.after)}</span></div>)}
      </div>
      <div className="approval-two-col"><section><span className="approval-kicker">Validation</span><CheckList items={details.validation} /></section><section><span className="approval-kicker">Rollback</span><p>{details.rollback}</p></section></div>
    </div>
  );
}

function ExceptionPreview({ view }: { view: ApprovalView }) {
  if (view.payload.approval_type !== 'exception') return null;
  const details = view.payload.details;
  return (
    <div className="approval-preview">
      <section className="approval-lead-block"><span className="approval-kicker">Rule remains in force</span><h2>{details.rule_label}</h2><span className="meta">{details.rule_id}</span></section>
      <div className="approval-facts"><Fact label="Exception scope">{details.scope}</Fact><Fact label="Expires">{shortDateTime(details.exception_expires_at)}</Fact></div>
      <section><span className="approval-kicker">Reason</span><p>{details.reason}</p></section>
      <section><span className="approval-kicker">Compensating controls</span><CheckList items={details.compensating_controls} /></section>
    </div>
  );
}

function GovernancePreview({ view }: { view: ApprovalView }) {
  if (view.payload.approval_type !== 'agent_governance') return null;
  const details = view.payload.details;
  const agent = [view.identities.requester_agent, ...view.identities.target_agents].find((item) => item.id === details.agent_id);
  return (
    <div className="approval-preview">
      <AgentIdentity name={agent?.name ?? 'Workspace agent'} email={agent?.email} label="Configuration target" />
      <div className="approval-compare"><div><span>Current schedule</span><strong>{details.current_schedule ?? 'None'}</strong></div><Icon name="arrow" /><div><span>Proposed schedule</span><strong>{details.proposed_schedule ?? 'None'}</strong></div></div>
      <div className="approval-two-col"><section><span className="approval-kicker">Tools · current</span><CheckList items={details.current_tools} empty="No tools" /></section><section><span className="approval-kicker">Tools · proposed</span><CheckList items={details.proposed_tools} empty="No tools" /></section></div>
      {details.setting_changes.length > 0 && <div className="approval-change-table" role="table" aria-label="Configuration changes">{details.setting_changes.map((change) => <div role="row" key={change.key}><span><strong>{change.key}</strong></span><span>{displayValue(change.before)}</span><span>{displayValue(change.after)}</span></div>)}</div>}
      <section><span className="approval-kicker">Affected permissions</span><CheckList items={details.affected_permissions} empty="No permission changes" /></section>
    </div>
  );
}

function ApprovalPreview({ view }: { view: ApprovalView }) {
  switch (view.payload.approval_type) {
    case 'run_plan': return <RunPlanPreview view={view} />;
    case 'team_commitment': return <TeamCommitmentPreview view={view} />;
    case 'access': return <AccessPreview view={view} />;
    case 'communication': return <CommunicationPreview view={view} />;
    case 'shared_learning': return <SharedLearningPreview view={view} />;
    case 'deliverable': return <DeliverablePreview view={view} />;
    case 'data_disclosure': return <DisclosurePreview view={view} />;
    case 'record_change': return <RecordChangePreview view={view} />;
    case 'exception': return <ExceptionPreview view={view} />;
    case 'agent_governance': return <GovernancePreview view={view} />;
  }
}

export function ReviewerSequence({ view }: { view: ApprovalView }) {
  return (
    <section className="approval-reviewers" aria-labelledby="approval-reviewers-heading">
      <div className="row"><h2 className="section-title" id="approval-reviewers-heading">Reviewers</h2><span className="grow" /><span className="meta">{view.payload.policy.mode === 'sequential' ? 'In order' : 'Parallel'}</span></div>
      <ol>
        {[...view.steps].sort((a, b) => a.order - b.order).map((step, index) => {
          const votes = view.votes.filter((vote) => vote.step_id === step.step_id);
          const currentNames = step.current_reviewer_member_ids.map((id) => view.identities.reviewers.find((item) => item.member_id === id)?.name).filter(Boolean);
          return (
            <li key={step.step_id} data-state={step.status}>
              <span className="approval-reviewer-index">{step.status === 'approved' ? <Icon name="check" size={13} /> : index + 1}</span>
              <Avatar person={{ name: votes[0]?.reviewer_name ?? currentNames[0] ?? '?' }} size={28} />
              <span className="col grow" style={{ gap: 2 }}><strong>{step.label}</strong><span className="meta">{currentNames.length > 0 ? currentNames.join(', ') : step.status === 'blocked' ? 'Waits for the prior step' : step.status.replaceAll('_', ' ')}{votes.map((vote) => <span className="approval-vote" key={vote.id}>{vote.reviewer_name} · {vote.decision.replaceAll('_', ' ')} · {shortDateTime(vote.recorded_at)}{vote.note && <span>{vote.note}</span>}</span>)}</span></span>
              <span className="approval-quorum">{step.approvals_recorded}/{step.quorum}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function ApprovalDecisionHeader({ view }: { view: ApprovalView }) {
  const pending = view.status === 'pending';
  return <header className="approval-decision-header">
    <div className="row"><h1>{pending ? 'Your decision' : ['approved', 'declined', 'changes_requested'].includes(view.status) ? 'Decision recorded' : approvalStatusLabel(view.status)}</h1><span className="grow" />{view.payload.illustrative && <span className="pill illustrative">Illustrative</span>}</div>
    <p>{pending ? approvalDecisionPrompt(view) : `${approvalStatusLabel(view.status)} · Revision ${view.payload.authorization.revision}`}</p>
    <div className="approval-thresholds" aria-label="Required approvals">
      {[...view.steps].sort((a, b) => a.order - b.order).map((step) => <span key={step.step_id} data-state={step.status}>
        <strong>{step.label}</strong> {step.approvals_recorded}/{step.quorum} approved{step.status === 'current' ? ' · Current' : step.status === 'blocked' ? ' · Next' : ''}
      </span>)}
    </div>
    <p className="meta">{view.payload.policy.mode === 'sequential' ? 'Review in order' : 'Parallel review'} · Expires {shortDateTime(view.payload.authorization.expires_at)}</p>
    {pending && view.capabilities.reason && <p className="approval-eligibility">{view.capabilities.reason}</p>}
  </header>;
}

function ResultState({ view }: { view: ApprovalView }) {
  const effect = approvalEffectLabel(view.effect.status);
  const work = approvalWorkLabel(view.work.status);
  const started = approvalWorkStartedLine(view);
  const authorizationState = view.status === 'approved' ? 'done' : view.status === 'pending' ? 'waiting' : 'failed';
  return (
    <section className="approval-result" aria-labelledby="approval-result-heading">
      <h2 className="section-title" id="approval-result-heading">Decision and result</h2>
      <div className="approval-result-track">
        <span data-state={authorizationState}><Icon name={view.status === 'approved' ? 'check' : view.status === 'pending' ? 'history' : 'close'} /> <strong>{approvalStatusLabel(view.status)}</strong><small>Human authorization</small></span>
        <Icon name="arrow" />
        <span data-state={view.work.status === 'completed' || view.work.status === 'admitted' ? 'done' : 'waiting'}><Icon name={view.work.status === 'completed' || view.work.status === 'admitted' ? 'check' : 'history'} /> <strong>{work}</strong><small>{started ?? approvalWorkReason(view.work.reason) ?? 'Dependent work'}</small></span>
        <Icon name="arrow" />
        <span data-state={view.effect.status === 'executed' ? 'done' : view.effect.status === 'failed' ? 'failed' : 'waiting'}><Icon name={view.effect.status === 'executed' ? 'check' : 'history'} /> <strong>{effect}</strong><small>{view.effect.reason ?? 'Provider effect'}</small></span>
      </div>
    </section>
  );
}

export function proposalFrom(view: ApprovalView, summary: string, draft?: { subject: string; body: string }): ApprovalProposal {
  const { context: _context, authorization: _authorization, policy: _policy, resource_bindings: _resourceBindings, ...proposal } = view.payload;
  if (draft && proposal.approval_type === 'communication' && proposal.details.draft_only && proposal.details.channel === 'email') {
    return { ...proposal, summary, details: { ...proposal.details, subject: draft.subject.trim(), body: draft.body.trim() } };
  }
  return { ...proposal, summary } as ApprovalProposal;
}

export function decisionError(caught: unknown): string {
  const reason = (caught as { reason?: string }).reason;
  if (reason === 'stale_authorization') return 'This proposal changed. Review the current version before deciding.';
  if (reason === 'reauth_required') return 'Sign in again, then review and confirm. Nothing will be submitted automatically.';
  if (['expired', 'approval_expired'].includes(reason ?? '')) return 'This request expired and cannot be approved.';
  if (['not_eligible', 'self_review', 'reviewer_not_eligible', 'self_review_forbidden'].includes(reason ?? '')) return 'You are not eligible for the current review step.';
  if (['already_voted', 'duplicate', 'duplicate_reviewer'].includes(reason ?? '')) return 'This decision was already recorded.';
  return 'Could not update this approval. Try again.';
}

export function ApprovalRequest({ request }: { request: RequestEntity }) {
  const adapter = useAdapter();
  const state = useAppState();
  const dispatch = useDispatch();
  const systemReduceMotion = useReducedMotion();
  const reduceMotion = systemReduceMotion || state.ui.reduceMotion;
  const [view, setView] = useState<ApprovalView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changeMode, setChangeMode] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const [revisionMode, setRevisionMode] = useState(false);
  const [revisionSummary, setRevisionSummary] = useState('');
  const [revisionNote, setRevisionNote] = useState('');
  const [revisionSubject, setRevisionSubject] = useState('');
  const [revisionBody, setRevisionBody] = useState('');
  const [needsReauth, setNeedsReauth] = useState(false);
  const [expiredHash, setExpiredHash] = useState<string | null>(null);
  const [routeMode, setRouteMode] = useState(false);
  const [routeMember, setRouteMember] = useState('');
  const [routeReason, setRouteReason] = useState('');
  const [menu, setMenu] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);

  const revisionScope = (approval: ApprovalView): ApprovalRevisionScope => ({
    viewerId: state.user.id, workspaceId: state.workspace.id, requestId: approval.request_id,
    revision: approval.payload.authorization.revision, hash: approval.payload.authorization.hash,
    authorizationExpiresAt: approval.payload.authorization.expires_at,
    canRevise: approval.capabilities.can_submit_revision && ['pending', 'changes_requested'].includes(approval.status)
      && approval.payload.approval_type === 'communication' && approval.payload.details.draft_only && approval.payload.details.channel === 'email',
  });

  useEffect(() => {
    let live = true;
    setLoadState('loading');
    setRevisionMode(false);
    setRevisionNote('');
    setChangeMode(false);
    setChangeNote('');
    setRouteMode(false);
    setRouteReason('');
    setNeedsReauth(false);
    setError(null);
    void adapter.rest.getApproval(state.workspace.id, request.id).then(
      (approval) => {
        if (!live) return;
        setView(approval);
        setRevisionSummary(approval.payload.summary);
        if (approval.payload.approval_type === 'communication') {
          setRevisionSubject(approval.payload.details.subject ?? '');
          setRevisionBody(approval.payload.details.body);
        }
        const restored = state.user.id ? takeApprovalRevisionDraft(revisionDraftStorage(), revisionScope(approval)) : null;
        if (restored) {
          setRevisionSubject(restored.subject);
          setRevisionBody(restored.body);
          setRevisionSummary(restored.summary);
          setRevisionNote(restored.changeNote);
          setRevisionMode(true);
          setError('Your unsaved rewrite is restored. Review it and explicitly save the new revision.');
        }
        setLoadState('ready');
      },
      (caught: unknown) => {
        if (!live) return;
        const status = (caught as { status?: number }).status;
        setLoadState(status === 404 ? 'missing' : 'error');
      },
    );
    return () => { live = false; };
  }, [adapter, state.workspace.id, state.user.id, request.id]);

  const syncRequest = async (): Promise<void> => {
    const updated = await adapter.rest.getRequest(state.workspace.id, request.id);
    dispatch({ type: 'entity/upsert', kind: 'request', id: updated.id, version: updated.version, data: updated });
    const beforeMine = request.approval?.pending_for_viewer ? 1 : 0;
    const beforeWaiting = request.approval?.waiting_on_others ? 1 : 0;
    const afterMine = updated.approval?.pending_for_viewer ? 1 : 0;
    const afterWaiting = updated.approval?.waiting_on_others ? 1 : 0;
    dispatch({
      type: 'counts/set',
      patch: {
        pendingForMe: Math.max(0, (state.counts.pendingForMe ?? state.counts.inbox) - beforeMine + afterMine),
        pendingForOthers: Math.max(0, (state.counts.pendingForOthers ?? 0) - beforeWaiting + afterWaiting),
      },
    });
    adapter.invalidateList(LIST_KEYS.history);
  };

  const mutate = async (operation: (approval: ApprovalView) => Promise<ApprovalView>): Promise<void> => {
    if (!view || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await operation(view);
      clearApprovalRevisionDraft(revisionDraftStorage());
      setNeedsReauth(false);
      setView(updated);
      setRevisionSummary(updated.payload.summary);
      if (updated.payload.approval_type === 'communication') {
        setRevisionSubject(updated.payload.details.subject ?? '');
        setRevisionBody(updated.payload.details.body);
      }
      setChangeMode(false);
      setRevisionMode(false);
      setRouteMode(false);
      await syncRequest().catch(() => setError('Update saved. The Inbox could not refresh; reload to see its latest status.'));
    } catch (caught) {
      setError(decisionError(caught));
      if (caught instanceof RestError && caught.reauthRequired) setNeedsReauth(true);
      if (['expired', 'approval_expired'].includes((caught as { reason?: string }).reason ?? '')) setExpiredHash(view.payload.authorization.hash);
      if (['stale_authorization', 'expired', 'approval_expired'].includes((caught as { reason?: string }).reason ?? '')) clearApprovalRevisionDraft(revisionDraftStorage());
      if (['stale_authorization', 'expired', 'approval_expired', 'reviewer_not_eligible', 'self_review_forbidden', 'duplicate_reviewer'].includes((caught as { reason?: string }).reason ?? '')) {
        await adapter.rest.getApproval(state.workspace.id, request.id).then((fresh) => {
          setView(fresh);
          setRevisionMode(false);
          setRevisionSummary(fresh.payload.summary);
          if (fresh.payload.approval_type === 'communication') {
            setRevisionSubject(fresh.payload.details.subject ?? '');
            setRevisionBody(fresh.payload.details.body);
          }
        }).catch(() => setLoadState('error'));
      }
    } finally {
      setBusy(false);
    }
  };

  const idempotencyKey = (action: string): string => `${action}:${request.id}:${Date.now()}:${crypto.randomUUID()}`;
  const decide = (decision: 'approve' | 'decline' | 'request_changes', note: string | null = null): void => {
    void mutate((approval) => adapter.rest.decideApproval(state.workspace.id, request.id, {
      decision,
      note,
      expected_authorization_revision: approval.payload.authorization.revision,
      expected_authorization_hash: approval.payload.authorization.hash,
      idempotency_key: idempotencyKey(decision),
    }));
  };

  const signInAgain = (): void => {
    if (!view) return;
    const url = adapter.auth.stepUpUrl(window.location.href, 'decision');
    if (url) {
      if (revisionMode && revisionScope(view).canRevise) {
        const saved = saveApprovalRevisionDraft(revisionDraftStorage(), revisionScope(view), {
          subject: revisionSubject, body: revisionBody, summary: revisionSummary, changeNote: revisionNote,
        });
        if (!saved) { setError('Your browser could not preserve this rewrite for sign-in. Copy your edits before reloading.'); return; }
      }
      window.location.assign(url);
    } else {
      void adapter.refreshAuth().then(() => { setNeedsReauth(false); setError('Authentication refreshed. Review this request and confirm again.'); })
        .catch(() => setError('Could not refresh authentication. Reload and sign in again.'));
    }
  };

  if (loadState === 'loading') return <div className="scroll"><div className="app-body"><Skeleton rows={6} label="Loading approval" /></div></div>;
  if (loadState === 'missing') return <div className="scroll"><div className="app-body"><EmptyState icon="admission" title="Approval not found" detail="It may have been withdrawn or you may no longer be eligible to read it." /></div></div>;
  if (loadState === 'error' || !view) return <div className="scroll"><div className="app-body"><EmptyState icon="trace" title="Could not load this approval" action={<Button onClick={() => window.location.reload()}>Reload</Button>} /></div></div>;

  const authorizationExpired = expiredHash === view.payload.authorization.hash || Date.parse(view.payload.authorization.expires_at) <= Date.now();
  const canApprove = !authorizationExpired && view.capabilities.allowed_decisions.includes('approve');
  const canDecline = !authorizationExpired && view.capabilities.allowed_decisions.includes('decline');
  const canRequestChanges = !authorizationExpired && view.capabilities.allowed_decisions.includes('request_changes');
  const canRevise = !authorizationExpired && view.capabilities.can_submit_revision;
  const resolved = view.status !== 'pending';
  // The decision routes require a sign-in within the Worker's step-up window.
  // Saying so before the click is a hint only: the 401 path below stays the
  // authority, and an unknown `authenticated_at` is treated as unknown, not stale.
  const signInStale = !resolved && (canApprove || canDecline || canRequestChanges) && decisionSignInStale(state.connection.authenticatedAt);
  const editableDraft = view.payload.approval_type === 'communication' && view.payload.details.draft_only && view.payload.details.channel === 'email';
  const draftChanged = editableDraft && view.payload.approval_type === 'communication' && (revisionSubject.trim() !== (view.payload.details.subject ?? '') || revisionBody.trim() !== view.payload.details.body);
  const invalidRevision = busy || !canRevise || revisionSummary.trim().length === 0 || revisionNote.trim().length === 0 || (editableDraft && revisionBody.trim().length === 0) || (!draftChanged && revisionSummary.trim() === view.payload.summary);
  const partnerWorkflowRecord = view.payload.approval_type === 'record_change' && view.payload.details.system_id === 'enterprise-partner-records';

  return (
    <div className="app-pane-body request-pane approval-shell">
      <div className="scroll request-scroll">
        <div className="col request-content">
          <ApprovalDecisionHeader view={view} />
          {partnerWorkflowRecord && <p className="partner-provenance-summary"><InputProvenanceBadge value={view.payload.illustrative ? 'sample' : 'customer'} /><span>{view.payload.illustrative ? 'For demonstration only. Approval does not confirm an external agreement.' : 'From externally agreed terms with a verifiable source.'}</span></p>}

          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={`${view.payload.approval_type}:${view.payload.authorization.revision}`} initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}>
              <ApprovalPreview view={view} />
            </motion.div>
          </AnimatePresence>

          <details className="approval-disclosure">
            <summary>Request details <span>{APPROVAL_META[view.payload.approval_type].label} · v{view.payload.authorization.revision}</span></summary>
            <div className="approval-request-details">
              <h2 className="section-title">{request.subject ?? request.label}</h2>
              <AgentIdentity name={view.identities.requester_agent.name} email={view.identities.requester_agent.email} label="Proposer" />
              <p>{view.payload.summary}</p><p>{view.payload.consequence}</p>
              <p className="meta">Request {request.id} · Policy {view.payload.policy.key} v{view.payload.policy.version}</p>
              <p className="meta">Source run {view.payload.context.source.run_id} · Source session {view.payload.context.source.session_id}</p>
            </div>
          </details>
          <ApprovalEvidence key={view.payload.authorization.revision} view={view} load={(id) => adapter.rest.getApprovalEvidence(state.workspace.id, request.id, id)} />
          <details className="approval-disclosure"><summary>Review history <span>Current revision</span></summary><ReviewerSequence view={view} /></details>
          {resolved && <ResultState view={view} />}
          {view.payload.illustrative && <p className="approval-simulation-note">Illustrative scenario. Names, prices, sources and effects shown here are fictional; no external message, access grant, disclosure or system change occurs.</p>}
        </div>
      </div>

      <div className="app-footer approval-footer" style={{ marginInline: -28 }}>
        <div className="col grow" style={{ gap: 3 }}>
          <span className="f-title">{resolved ? `${approvalStatusLabel(view.status)} · authorization v${view.payload.authorization.revision}` : revisionMode ? 'Editing draft · Save a new revision to continue' : approvalEffectCopy(view)}</span>
          {error && <span className="f-sub" role="alert">{error}</span>}
          {!error && !needsReauth && signInStale && <span className="f-sub">Recent sign-in required to decide · <a href={adapter.auth.stepUpUrl(typeof window === 'undefined' ? '/' : window.location.href, 'decision') ?? '#'} onClick={(event) => { event.preventDefault(); signInAgain(); }}>Sign in again</a></span>}
        </div>
        {needsReauth && <Button onClick={signInAgain}>Sign in again</Button>}
        {!resolved && !revisionMode && canRequestChanges && <Button disabled={busy} onClick={() => setChangeMode((open) => !open)}>Request changes</Button>}
        {!resolved && !revisionMode && canApprove && <Button primary disabled={busy} onClick={() => decide('approve')}>{busy ? 'Recording…' : approvalPrimaryAction(view)}</Button>}
        {!resolved && !revisionMode && !authorizationExpired && (canDecline || view.capabilities.can_route || view.capabilities.can_submit_revision) && (
          <span className="approval-more">
            <button ref={menuAnchor} type="button" className="icon-btn" aria-label="More approval actions" aria-expanded={menu} onClick={() => setMenu((open) => !open)}><Icon name="more" /></button>
            <Popover open={menu} onClose={() => setMenu(false)} anchorRef={menuAnchor} align="right" above width={240} label="Approval actions" portal className="menu">
              {canRevise && <MenuItem icon="doc" onClick={() => { setMenu(false); setRevisionMode(true); }}>{editableDraft ? 'Revise draft' : 'Revise proposal'}</MenuItem>}
              {canDecline && <MenuItem icon="close" onClick={() => { setMenu(false); decide('decline'); }}>Decline</MenuItem>}
              {view.capabilities.can_route && <MenuItem icon="users" onClick={() => { setMenu(false); setRouteMode(true); }}>Route reviewer</MenuItem>}
            </Popover>
          </span>
        )}
        {resolved && canRevise && <Button primary={resolved} disabled={busy} onClick={() => setRevisionMode((open) => !open)}>{editableDraft ? 'Revise draft' : 'Revise proposal'}</Button>}
      </div>

      {changeMode && (
        <div className="approval-inline-form" role="region" aria-label="Request changes">
          <label><span>What needs to change</span><textarea value={changeNote} onChange={(event) => setChangeNote(event.target.value)} maxLength={4000} autoFocus /></label>
          <Button onClick={() => setChangeMode(false)}>Cancel</Button><Button primary disabled={busy || !canRequestChanges || changeNote.trim().length === 0} onClick={() => decide('request_changes', changeNote.trim())}>Send back for changes</Button>
        </div>
      )}
      {revisionMode && (
        <div className={`approval-inline-form${editableDraft ? ' approval-draft-revision' : ''}`} role="region" aria-label="Revise proposal">
          {editableDraft && <><label><span>Revised email subject</span><input value={revisionSubject} onChange={(event) => setRevisionSubject(event.target.value)} maxLength={500} /></label><label className="approval-revision-body"><span>Revised email body</span><textarea value={revisionBody} onChange={(event) => setRevisionBody(event.target.value)} maxLength={20000} /></label></>}
          <label><span>Revised proposal summary</span><textarea value={revisionSummary} onChange={(event) => setRevisionSummary(event.target.value)} maxLength={1000} autoFocus /></label>
          <label><span>What changed</span><input value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} maxLength={2000} /></label>
          <Button onClick={() => { clearApprovalRevisionDraft(revisionDraftStorage()); setRevisionMode(false); setRevisionNote(''); setRevisionSummary(view.payload.summary); if (view.payload.approval_type === 'communication') { setRevisionSubject(view.payload.details.subject ?? ''); setRevisionBody(view.payload.details.body); } }}>Cancel</Button><Button primary disabled={invalidRevision} onClick={() => void mutate((approval) => adapter.rest.reviseApproval(state.workspace.id, request.id, { proposal: proposalFrom(approval, revisionSummary.trim(), editableDraft ? { subject: revisionSubject, body: revisionBody } : undefined), change_summary: revisionNote.trim(), expected_authorization_revision: approval.payload.authorization.revision, expected_authorization_hash: approval.payload.authorization.hash, idempotency_key: idempotencyKey('revision') }))}>Submit v{view.payload.authorization.revision + 1}</Button>
        </div>
      )}
      {routeMode && (
        <div className="approval-inline-form" role="region" aria-label="Route reviewer">
          <label><span>Eligible reviewer</span><select value={routeMember} onChange={(event) => setRouteMember(event.target.value)}><option value="">Choose reviewer</option>{view.identities.reviewers.map((reviewer) => <option key={reviewer.member_id} value={reviewer.member_id}>{reviewer.name} · {reviewer.authority_roles.join(', ') || 'member'}</option>)}</select></label>
          <label><span>Routing reason</span><input value={routeReason} onChange={(event) => setRouteReason(event.target.value)} maxLength={1000} /></label>
          <Button onClick={() => setRouteMode(false)}>Cancel</Button><Button primary disabled={busy || authorizationExpired || !view.capabilities.can_route || !routeMember || !routeReason.trim()} onClick={() => void mutate((approval) => adapter.rest.routeApproval(state.workspace.id, request.id, { step_id: approval.steps.find((step) => step.status === 'current')?.step_id ?? approval.capabilities.eligible_step_ids[0] ?? '', reviewer_member_id: routeMember, reason: routeReason.trim(), expected_authorization_revision: approval.payload.authorization.revision, expected_authorization_hash: approval.payload.authorization.hash, idempotency_key: idempotencyKey('route') }))}>Route review</Button>
        </div>
      )}
    </div>
  );
}
