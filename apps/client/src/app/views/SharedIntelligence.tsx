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
    needs_review: 'Heightened review',
    ready_for_review: 'Ready for review',
    pending_review: 'In human review',
    published: 'Published to Library',
    revoked: 'Withdrawn',
    declined: 'Declined',
  }[proposal.status];
}

function errorCopy(error: unknown): string {
  return error instanceof Error ? error.message : 'Shared Intelligence could not complete that request.';
}

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
        ? 'Private draft scored and saved. Check the evidence before sharing it with Admin.'
        : 'Private draft saved, but scoring is unavailable. It cannot be published until it has a fresh assessment.');
    } catch (error) {
      setNotice(errorCopy(error));
    } finally {
      setBusy(null);
    }
  };

  const queueForAdmin = async (proposal: SharedIntelligenceProposal): Promise<void> => {
    const goalId = goalByProposal[proposal.id] ?? workspace?.goals[0]?.id;
    if (!goalId) return;
    setBusy(`triage:${proposal.id}`);
    setNotice(null);
    try {
      const updated = await adapter.rest.queueSharedIntelligenceProposal(state.workspace.id, proposal.id, goalId);
      setWorkspace((current) => current ? { ...current, proposals: current.proposals.map((item) => item.id === updated.id ? updated : item) } : current);
      setNotice(updated.triage_assessment?.status === 'complete'
        ? 'Shared with Admin using only the exact approved excerpts. Jev priority is frozen against the selected goal.'
        : 'Shared with Admin, but Jev prioritization is unavailable. The candidate is visible and honestly unranked.');
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
      setNotice(updated.library_source_id ? 'Team access withdrawn. The immutable publication remains in the audit record.' : 'Private proposal withdrawn.');
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
          <p>Hermes finds candidate lessons in completed work you own. You choose the exact visible excerpts, then an independent human reviews the frozen publication before any team can use it.</p>
        </div>
        <span className="shared-intelligence-private">Private until approved</span>
      </div>
      <p className="shared-intelligence-boundary">{workspace.data_boundary}</p>
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
            <div><h3>Review the private draft</h3><p>The score routes attention; it does not validate the lesson or prove a business outcome.</p></div>
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
                return <label key={evidence.run_id}><span>{run?.session_title ?? 'Completed run'} · {run ? new Date(run.ended_at).toLocaleDateString() : ''}</span><textarea required maxLength={1000} rows={3} value={evidence.approved_excerpt} onChange={(event) => setDraft({ ...draft, evidence: draft.evidence.map((item, itemIndex) => itemIndex === index ? { ...item, approved_excerpt: event.target.value } : item) })} /><small>Must remain a verified, redacted excerpt. Hermes separately hash-pins the complete source message, so any later edit blocks publication.</small></label>;
              })}
            </div>
          </fieldset>
          <div className="shared-intelligence-actions">
            <Button type="submit" primary disabled={busy === 'save' || draft.team_ids.length === 0}>{busy === 'save' ? 'Checking…' : 'Check and save private draft'}</Button>
            <span>Uses a fixed, versioned rubric. Provisional thresholds only determine the review route.</span>
          </div>
        </motion.form>
      )}

      <div className="shared-intelligence-section-head">
        <div><h3>Suggested from your completed work</h3><p>Suggestions are local drafts derived from sanitized visible outcomes and observable step labels.</p></div>
      </div>
      {workspace.discoveries.length === 0 ? (
        <EmptyState icon="skill" title="No candidate lessons yet" detail="Complete work with a team-assigned agent. Hermes will suggest private drafts when a visible outcome is safe to quote." />
      ) : (
        <div className="shared-intelligence-grid">
          {workspace.discoveries.map((discovery) => (
            <article className="shared-intelligence-card" key={discovery.id}>
              <div className="shared-intelligence-card-head"><span>possible pattern · {discovery.evidence_strength}</span><span>{discovery.source_run_ids.length} run{discovery.source_run_ids.length === 1 ? '' : 's'}</span></div>
              <h4>{discovery.suggested_title}</h4>
              <p>{discovery.suggested_lesson}</p>
              <p className="meta">{discovery.warnings.join(' ')}</p>
              <Button small onClick={() => begin(discovery)}>Review draft</Button>
            </article>
          ))}
        </div>
      )}

      <div className="shared-intelligence-section-head">
        <div><h3>Publication proposals</h3><p>Only the exact approved version becomes a team-scoped Library source.</p></div>
      </div>
      {workspace.proposals.length === 0 ? <p className="meta">No proposals yet.</p> : (
        <div className="shared-intelligence-proposals">
          {workspace.proposals.map((proposal) => (
            <article className="shared-intelligence-proposal" key={proposal.id}>
              <div className="shared-intelligence-proposal-main">
                <div className="shared-intelligence-card-head"><span data-status={proposal.status}>{copyForStatus(proposal)}</span><span>{proposal.audiences.map((team) => team.name).join(' + ')}</span></div>
                <h4>{proposal.title}</h4>
                <p>{proposal.lesson}</p>
                <div className="shared-intelligence-score">
                  <strong>{proposal.assessment.composite_score === null ? '—' : Math.round(proposal.assessment.composite_score)}</strong>
                  <span>rubric score<br />{proposal.assessment.evidence_count} verified excerpt{proposal.assessment.evidence_count === 1 ? '' : 's'}</span>
                </div>
                <details className="shared-intelligence-evidence-preview"><summary>Review the exact excerpts shared with Admin</summary>{proposal.evidence.map((evidence) => <blockquote key={evidence.id}><small>{evidence.session_title}</small><p>{evidence.approved_excerpt}</p></blockquote>)}</details>
                {proposal.assessment.warnings.map((warning) => <p className="meta" key={warning}>{warning}</p>)}
              </div>
              <div className="shared-intelligence-proposal-actions">
                {proposal.status === 'pending_review' && proposal.approval_request_id && <Button small onClick={() => nav(REQ(proposal.approval_request_id!))}>Open review</Button>}
                {['ready_for_review', 'needs_review'].includes(proposal.status) && proposal.triage_status === 'private' && workspace.goals.length > 0 && <>
                  <label className="shared-intelligence-goal-select"><span>Admin goal</span><select value={goalByProposal[proposal.id] ?? workspace.goals[0]?.id ?? ''} onChange={(event) => setGoalByProposal((current) => ({ ...current, [proposal.id]: event.target.value }))}>{workspace.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>
                  <Button small primary disabled={busy === `triage:${proposal.id}`} onClick={() => void queueForAdmin(proposal)}>{busy === `triage:${proposal.id}` ? 'Sharing…' : 'Share with Admin'}</Button>
                </>}
                {['ready_for_review', 'needs_review'].includes(proposal.status) && proposal.triage_status === 'private' && workspace.goals.length === 0 && <span className="meta">An Admin must add a goal before this candidate can enter triage.</span>}
                {proposal.triage_status === 'queued' && <span className="meta">Waiting for Admin triage</span>}
                {proposal.triage_status === 'excluded' && <span className="meta">Excluded from the active queue · reversible by an Admin</span>}
                {!['pending_review', 'revoked'].includes(proposal.status) && <Button small quiet disabled={busy === `revoke:${proposal.id}`} onClick={() => void revoke(proposal)}>Withdraw</Button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </motion.section>
  );
}
