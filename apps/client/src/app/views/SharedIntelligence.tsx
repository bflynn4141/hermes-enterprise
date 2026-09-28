import { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  REQ,
  type CreateSharedIntelligenceProposal,
  type SharedIntelligenceDiscovery,
  type SharedIntelligenceProposal,
  type SharedIntelligenceWorkspace,
} from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Button, EmptyState, Skeleton } from '../ui/primitives.js';

type Draft = CreateSharedIntelligenceProposal;

function copyForStatus(proposal: SharedIntelligenceProposal): string {
  if (proposal.status === 'needs_review' && proposal.assessment.status !== 'complete') return 'Scoring unavailable';
  return {
    needs_review: 'Needs a closer review',
    ready_for_review: 'Ready for review',
    pending_review: 'In human review',
    published: 'Published to Library',
    revoked: 'Withdrawn',
    declined: 'Declined',
  }[proposal.status];
}

const ERROR_COPY: Readonly<Record<string, string>> = {
  invalid_shared_intelligence_text: 'Some of the text could not be saved. Check each field and try again.',
  not_found: 'That item no longer exists. Refresh and try again.',
  shared_intelligence_admin_triage_required: 'An Admin needs to look at this first.',
  shared_intelligence_approval_stale: 'Something changed after this was reviewed. Check it again.',
  shared_intelligence_assessment_unavailable: 'Scoring is not available right now. Try again later.',
  shared_intelligence_audience_changed: 'The teams it is shared with changed. Check the draft again.',
  shared_intelligence_duplicate: 'This lesson has already been proposed.',
  shared_intelligence_evidence_changed: 'A quoted message changed after it was chosen. Choose the excerpt again.',
  shared_intelligence_evidence_forbidden: 'You can only quote your own finished work.',
  shared_intelligence_evidence_revoked: 'A quoted message is no longer available.',
  shared_intelligence_excerpt_unverified: 'Each excerpt must be copied exactly from a message people could see.',
  shared_intelligence_goal_changed: 'That goal changed. Choose it again.',
  shared_intelligence_goal_forbidden: 'You cannot use that goal.',
  shared_intelligence_goal_inactive: 'That goal is no longer active.',
  shared_intelligence_goal_missing: 'That goal no longer exists.',
  shared_intelligence_goal_team_missing: 'That goal no longer exists.',
  shared_intelligence_not_draft: 'This is no longer a private draft.',
  shared_intelligence_not_private: 'This is no longer a private draft.',
  shared_intelligence_requester_override_forbidden: 'You cannot review your own proposal.',
  shared_intelligence_review_pending: 'This is already waiting for review.',
  shared_intelligence_reviewer_unavailable: 'Nobody else can review this yet.',
  shared_intelligence_team_forbidden: 'You cannot share with that team.',
  shared_intelligence_triage_missing: 'This is not waiting for an Admin right now. Refresh and try again.',
  shared_intelligence_triage_state: 'This is not waiting for an Admin right now. Refresh and try again.',
  admin_required: 'Only a workspace Admin can do this.',
  not_admin: 'Only a workspace Admin can do this.',
  reauth_required: 'This needs a recent sign-in. Sign in again to continue.',
};

/** A refusal as a sentence, keyed on the server's reason code; never the server's own text. */
export function sharedIntelligenceErrorCopy(error: unknown): string {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return (typeof reason === 'string' && ERROR_COPY[reason]) || 'That did not work. Nothing was changed. Try again.';
}
const errorCopy = sharedIntelligenceErrorCopy;

/**
 * The server's review cautions, in plain words. They are written for
 * reviewers of the scoring system ("runtime", "composite", "thresholds"); the
 * person reading them needs what to watch for. An unknown caution becomes one
 * generic line rather than the server's text.
 */
const WARNING_COPY: Readonly<Record<string, string>> = {
  'A completed runtime is not proof that the business outcome succeeded.': 'Finished work does not prove the business result was good.',
  'The 70-point, 0.55-confidence, two-run routing thresholds are provisional review aids, not validated quality gates.': 'The score only decides how closely this is reviewed. It does not judge quality.',
  'Only one completed run supports this proposal; require heightened human review.': 'Only one piece of work supports this, so it gets a closer review.',
  'The model found material uncertainty; show the evidence gap to the reviewer.': 'The check found real uncertainty. Show the reviewer what is missing.',
  'At least one model judgment is low-confidence; do not treat the composite as reliable.': 'Part of the score is uncertain. Do not rely on the total.',
  'Scoring is unavailable. This draft cannot be published until a fresh scored review is created.': 'This draft could not be scored, so it cannot be published until it is checked again.',
  'Jev ranks human attention; it does not decide publication or prove that a business outcome succeeded.': 'The priority only suggests what to look at first. It does not decide publication or prove results.',
  'Priority thresholds are versioned, provisional review aids rather than validated quality gates.': 'Priority cut-offs are a starting point, not a quality check.',
  'Only one approved excerpt supports this candidate.': 'Only one excerpt supports this.',
  'The sensitivity signal requires a close privacy review before reuse.': 'This may include sensitive details. Check privacy closely before reuse.',
  'Jev prioritization is unavailable. The candidate remains visible and unranked for human triage.': 'Priority could not be worked out. It stays in the list without a rank.',
  'Unassessed possible pattern only. Edit and verify it before asking for scored review.': 'Not checked yet. Edit and confirm it before asking for a scored review.',
  'Frequency is not corroboration or priority. Runtime completion does not establish business success.': 'Seeing something often does not make it right, and finished work does not prove success.',
  'Single-source suggestion; show this evidence weakness during heightened review.': 'Based on one piece of work only.',
};

export function sharedIntelligenceWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings.map((warning) => WARNING_COPY[warning] ?? 'Check the evidence closely before relying on this.'))];
}

/** What stays out of Shared Intelligence, for the owner's view. */
const OWNER_BOUNDARY = 'Only finished work you own is shown. A proposal quotes only messages people could see. Private steps, tool details, hidden reasoning, sign-in details and other members’ work stay out.';

export function SharedIntelligence() {
  const adapter = useAdapter();
  const state = useAppState();
  const nav = useNav();
  const reduceMotion = useReducedMotion();
  const [workspace, setWorkspace] = useState<SharedIntelligenceWorkspace | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>('load');
  const [notice, setNotice] = useState<string | null>(null);
  const [goalByProposal, setGoalByProposal] = useState<Record<string, string>>({});

  const load = async (): Promise<void> => {
    setBusy('load');
    try {
      setWorkspace(await adapter.rest.sharedIntelligence(state.workspace.id));
      setNotice(null);
    } catch (error) {
      setNotice(errorCopy(error));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    let live = true;
    setBusy('load');
    void adapter.rest.sharedIntelligence(state.workspace.id)
      .then((result) => { if (live) { setWorkspace(result); setNotice(null); } })
      .catch((error: unknown) => { if (live) setNotice(errorCopy(error)); })
      .finally(() => { if (live) setBusy(null); });
    return () => { live = false; };
  }, [adapter.rest, state.workspace.id]);

  const runsById = useMemo(() => new Map(workspace?.eligible_runs.map((run) => [run.id, run]) ?? []), [workspace]);

  const begin = (discovery: SharedIntelligenceDiscovery): void => {
    const firstRun = runsById.get(discovery.source_run_ids[0] ?? '');
    if (!firstRun || !workspace) return;
    setDraft({
      agent_id: firstRun.agent_id,
      title: discovery.suggested_title,
      goal: discovery.suggested_goal,
      lesson: discovery.suggested_lesson,
      rationale: discovery.suggested_rationale,
      team_ids: workspace.teams.map((team) => team.id),
      evidence: discovery.approved_excerpts.map(({ run_id, approved_excerpt }) => ({ run_id, approved_excerpt })),
    });
    setNotice(null);
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy('save');
    setNotice(null);
    try {
      const proposal = await adapter.rest.createSharedIntelligenceProposal(state.workspace.id, draft);
      setWorkspace((current) => current ? { ...current, proposals: [proposal, ...current.proposals] } : current);
      setDraft(null);
      setNotice(proposal.assessment.status === 'complete'
        ? 'Private draft scored and saved. Check the excerpts before sharing it with an Admin.'
        : 'Private draft saved, but it could not be scored. It cannot be published until it is checked again.');
    } catch (error) {
      setNotice(errorCopy(error));
    } finally {
      setBusy(null);
    }
  };

  const queueForAdmin = async (proposal: SharedIntelligenceProposal): Promise<void> => {
    const goalId = goalByProposal[proposal.id] ?? workspace?.goals[0]?.id;
    if (!goalId) return;
    setBusy(`share:${proposal.id}`);
    setNotice(null);
    try {
      const updated = await adapter.rest.queueSharedIntelligenceProposal(state.workspace.id, proposal.id, goalId);
      setWorkspace((current) => current ? { ...current, proposals: current.proposals.map((item) => item.id === updated.id ? updated : item) } : current);
      setNotice(updated.triage_assessment?.status === 'complete'
        ? 'Shared with an Admin, with only the excerpts you approved. Its priority is set against the goal you chose.'
        : 'Shared with an Admin. Its priority could not be worked out, so it is listed without a rank.');
    } catch (error) {
      setNotice(errorCopy(error));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (proposal: SharedIntelligenceProposal): Promise<void> => {
    setBusy(`revoke:${proposal.id}`);
    setNotice(null);
    try {
      const updated = await adapter.rest.revokeSharedIntelligenceProposal(state.workspace.id, proposal.id);
      setWorkspace((current) => current ? { ...current, proposals: current.proposals.map((item) => item.id === updated.id ? updated : item) } : current);
      setNotice(updated.library_source_id ? 'Teams can no longer use it. History keeps a record that it was published.' : 'Private proposal withdrawn.');
    } catch (error) {
      setNotice(errorCopy(error));
    } finally {
      setBusy(null);
    }
  };

  if (!workspace && busy === 'load') return <Skeleton rows={5} label="Loading Shared Intelligence" />;
  if (!workspace) return <EmptyState icon="skill" title="Shared Intelligence is unavailable" detail={notice} action={<Button onClick={() => void load()}>Try again</Button>} />;

  return (
    <motion.section
      className="shared-intelligence"
      aria-labelledby="shared-intelligence-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.16 }}
    >
      <div className="shared-intelligence-intro">
        <div>
          <h2 id="shared-intelligence-title">Turn completed work into reviewed reference material</h2>
          <p>Hermes finds possible lessons in finished work you own. You choose the exact excerpts to quote, then another person reviews it before any team can use it.</p>
        </div>
        <span className="shared-intelligence-private">Private until approved</span>
      </div>
      <p className="shared-intelligence-boundary">{OWNER_BOUNDARY}</p>
      {notice && <p className="shared-intelligence-notice" role="status">{notice}</p>}

      {draft && (
        <motion.form
          className="shared-intelligence-editor"
          onSubmit={(event) => { event.preventDefault(); void save(); }}
          initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.16 }}
        >
          <div className="shared-intelligence-section-head">
            <div><h3>Review the private draft</h3><p>The score only decides how closely this is reviewed. It does not prove the lesson is right.</p></div>
            <Button quiet onClick={() => setDraft(null)}>Cancel</Button>
          </div>
          <div className="shared-intelligence-form-grid">
            <label className="wide"><span>Title</span><input required maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label><span>Goal</span><textarea required maxLength={1000} rows={3} value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} /></label>
            <label><span>Reusable lesson</span><textarea required maxLength={4000} rows={5} value={draft.lesson} onChange={(event) => setDraft({ ...draft, lesson: event.target.value })} /></label>
            <label className="wide"><span>Why it may help</span><textarea required maxLength={4000} rows={4} value={draft.rationale} onChange={(event) => setDraft({ ...draft, rationale: event.target.value })} /></label>
          </div>
          <fieldset>
            <legend>Audience after approval</legend>
            <div className="shared-intelligence-checks">
              {workspace.teams.map((team) => <label key={team.id}><input type="checkbox" checked={draft.team_ids.includes(team.id)} onChange={(event) => setDraft({ ...draft, team_ids: event.target.checked ? [...draft.team_ids, team.id] : draft.team_ids.filter((id) => id !== team.id) })} />{team.name}</label>)}
            </div>
          </fieldset>
          <fieldset>
            <legend>Visible evidence excerpts</legend>
            <div className="shared-intelligence-evidence-list">
              {draft.evidence.map((evidence, index) => {
                const run = runsById.get(evidence.run_id);
                return <label key={evidence.run_id}><span>{run?.session_title ?? 'Finished work'}{run ? ` · ${new Date(run.ended_at).toLocaleDateString()}` : ''}</span><textarea required maxLength={1000} rows={3} value={evidence.approved_excerpt} onChange={(event) => setDraft({ ...draft, evidence: draft.evidence.map((item, itemIndex) => itemIndex === index ? { ...item, approved_excerpt: event.target.value } : item) })} /><small>Keep it an exact quote with private details removed. If the original message changes later, this cannot be published.</small></label>;
              })}
            </div>
          </fieldset>
          <div className="shared-intelligence-actions">
            <Button type="submit" primary disabled={busy === 'save' || draft.team_ids.length === 0}>{busy === 'save' ? 'Checking…' : 'Check and save private draft'}</Button>
            <span>Hermes scores every draft the same way. The score only decides how closely it is reviewed.</span>
          </div>
        </motion.form>
      )}

      <div className="shared-intelligence-section-head">
        <div><h3>Suggested from your finished work</h3><p>Suggestions are private drafts based on results people could see.</p></div>
      </div>
      {workspace.discoveries.length === 0 ? (
        <EmptyState icon="skill" title="No possible lessons yet" detail="Finish work with an agent that belongs to a team. Hermes suggests private drafts when a result is safe to quote." />
      ) : (
        <div className="shared-intelligence-grid">
          {workspace.discoveries.map((discovery) => (
            <article className="shared-intelligence-card" key={discovery.id}>
              <div className="shared-intelligence-card-head"><span>Possible pattern · {discovery.evidence_strength === 'unassessed' ? 'Not checked yet' : 'Checked'}</span><span>Based on {discovery.source_run_ids.length} task{discovery.source_run_ids.length === 1 ? '' : 's'}</span></div>
              <h4>{discovery.suggested_title}</h4>
              <p>{discovery.suggested_lesson}</p>
              <p className="meta">{sharedIntelligenceWarnings(discovery.warnings).join(' ')}</p>
              <Button small onClick={() => begin(discovery)}>Review draft</Button>
            </article>
          ))}
        </div>
      )}

      <div className="shared-intelligence-section-head">
        <div><h3>Proposals</h3><p>Only the version that was approved is added to the Library, for the teams you chose.</p></div>
      </div>
      {workspace.proposals.length === 0 ? <EmptyState compact icon="loop" title="No proposals yet" /> : (
        <div className="shared-intelligence-proposals">
          {workspace.proposals.map((proposal) => (
            <article className="shared-intelligence-proposal" key={proposal.id}>
              <div className="shared-intelligence-proposal-main">
                <div className="shared-intelligence-card-head"><span data-status={proposal.status}>{copyForStatus(proposal)}</span><span>{proposal.audiences.map((team) => team.name).join(' + ')}</span></div>
                <h4>{proposal.title}</h4>
                <p>{proposal.lesson}</p>
                <div className="shared-intelligence-score">
                  <strong>{proposal.assessment.composite_score === null ? '—' : Math.round(proposal.assessment.composite_score)}</strong>
                  <span>review score<br />{proposal.assessment.evidence_count} checked excerpt{proposal.assessment.evidence_count === 1 ? '' : 's'}</span>
                </div>
                <details className="shared-intelligence-evidence-preview"><summary>Review the exact excerpts shared with Admin</summary>{proposal.evidence.map((evidence) => <blockquote key={evidence.id}><small>{evidence.session_title}</small><p>{evidence.approved_excerpt}</p></blockquote>)}</details>
                {sharedIntelligenceWarnings(proposal.assessment.warnings).map((warning) => <p className="meta" key={warning}>{warning}</p>)}
              </div>
              <div className="shared-intelligence-proposal-actions">
                {proposal.status === 'pending_review' && proposal.approval_request_id && <Button small onClick={() => nav(REQ(proposal.approval_request_id!))}>Open review</Button>}
                {['ready_for_review', 'needs_review'].includes(proposal.status) && proposal.triage_status === 'private' && workspace.goals.length > 0 && <>
                  <label className="shared-intelligence-goal-select"><span>Admin goal</span><select value={goalByProposal[proposal.id] ?? workspace.goals[0]?.id ?? ''} onChange={(event) => setGoalByProposal((current) => ({ ...current, [proposal.id]: event.target.value }))}>{workspace.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>
                  <Button small primary disabled={busy === `share:${proposal.id}`} onClick={() => void queueForAdmin(proposal)}>{busy === `share:${proposal.id}` ? 'Sharing…' : 'Share with Admin'}</Button>
                </>}
                {['ready_for_review', 'needs_review'].includes(proposal.status) && proposal.triage_status === 'private' && workspace.goals.length === 0 && <span className="meta">An Admin needs to add a goal before this can be shared.</span>}
                {proposal.triage_status === 'queued' && <span className="meta">Waiting for an Admin to look at it</span>}
                {proposal.triage_status === 'excluded' && <span className="meta">Set aside by an Admin · they can bring it back</span>}
                {!['pending_review', 'revoked'].includes(proposal.status) && <Button small quiet disabled={busy === `revoke:${proposal.id}`} onClick={() => void revoke(proposal)}>Withdraw</Button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </motion.section>
  );
}
