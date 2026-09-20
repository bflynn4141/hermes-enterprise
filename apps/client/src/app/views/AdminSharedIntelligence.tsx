import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  REQ,
  type SharedIntelligenceAdminCandidate,
  type SharedIntelligenceAdminWorkspace,
  type SharedIntelligenceTriageDecision,
} from '@hermes/shared';
import { useAdapter, useAppState, useIsAdmin, useNav } from '../store-context.js';
import { Button, EmptyState, Skeleton } from '../ui/primitives.js';

const REASON_LABELS = {
  goal_aligned: 'Strong goal fit', high_impact: 'High impact', novel_signal: 'Novel signal',
  corroborated: 'Corroborated', urgent: 'Time-sensitive', high_uncertainty: 'High uncertainty',
  sensitivity_review: 'Privacy review', single_source: 'Single source', low_goal_fit: 'Low goal fit',
  low_confidence: 'Low confidence',
} as const;

const AXIS_LABELS = {
  relevance: 'Goal relevance', impact: 'Expected impact', novelty: 'Novelty',
  corroboration: 'Corroboration', urgency: 'Urgency', uncertainty: 'Uncertainty', sensitivity: 'Sensitivity',
} as const;

function recommendation(candidate: SharedIntelligenceAdminCandidate): string {
  const assessment = candidate.proposal.triage_assessment;
  if (!assessment || assessment.status !== 'complete') return 'Unranked · assess manually';
  return assessment.recommendation === 'include' ? 'Jev suggests review'
    : assessment.recommendation === 'exclude' ? 'Jev suggests deprioritize'
      : 'Jev suggests close judgment';
}

function score(candidate: SharedIntelligenceAdminCandidate): string {
  const value = candidate.proposal.triage_assessment?.priority_score;
  return value === null || value === undefined ? '—' : String(Math.round(value));
}

function errorCopy(error: unknown): string {
  return error instanceof Error ? error.message : 'Shared Intelligence could not complete that request.';
}

export function AdminSharedIntelligence() {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const admin = useIsAdmin();
  const systemReduceMotion = useReducedMotion();
  const reduceMotion = !!systemReduceMotion || state.ui.reduceMotion;
  const [workspace, setWorkspace] = useState<SharedIntelligenceAdminWorkspace | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<'queued' | 'included' | 'excluded' | 'all'>('queued');
  const [goalId, setGoalId] = useState('all');
  const [period, setPeriod] = useState<'30' | 'all'>('30');
  const [busy, setBusy] = useState<string | null>('load');
  const [notice, setNotice] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [decision, setDecision] = useState<'exclude' | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [assessmentGoalId, setAssessmentGoalId] = useState('');
  const [addingGoal, setAddingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState({ scope: 'workspace' as 'workspace' | 'team', team_id: '', title: '', detail: '' });

  useEffect(() => {
    if (!admin) return;
    let current = true;
    setBusy('load');
    void adapter.rest.sharedIntelligenceAdmin(state.workspace.id)
      .then((value) => {
        if (!current) return;
        setWorkspace(value);
        setSelectedId((id) => id ?? value.candidates[0]?.proposal.id ?? null);
      })
      .catch((error: unknown) => { if (current) setNotice(errorCopy(error)); })
      .finally(() => { if (current) setBusy(null); });
    return () => { current = false; };
  }, [adapter.rest, admin, state.workspace.id]);

  const candidates = useMemo(() => {
    if (!workspace) return [];
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1_000;
    return workspace.candidates.filter((candidate) => {
      if (status !== 'all' && candidate.proposal.triage_status !== status) return false;
      if (goalId !== 'all' && candidate.goal.id !== goalId) return false;
      if (period === '30' && new Date(candidate.proposal.triage_submitted_at ?? 0).getTime() < cutoff) return false;
      return true;
    });
  }, [workspace, status, goalId, period]);

  useEffect(() => {
    if (!candidates.some((candidate) => candidate.proposal.id === selectedId)) {
      setSelectedId(candidates[0]?.proposal.id ?? null);
    }
  }, [candidates, selectedId]);

  const selected = candidates.find((candidate) => candidate.proposal.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) return;
    const goals = workspace?.goals ?? [];
    const activeGoal = goals.find((goal) => goal.id === selected.goal.id)?.id ?? goals[0]?.id ?? '';
    setAssessmentGoalId(activeGoal);
  }, [selected?.proposal.id, workspace?.goals]);

  const act = async (input: SharedIntelligenceTriageDecision): Promise<void> => {
    if (!selected) return;
    setBusy(`decision:${selected.proposal.id}`);
    setNotice(null);
    setApprovalId(null);
    try {
      const result = await adapter.rest.decideSharedIntelligenceTriage(state.workspace.id, selected.proposal.id, input);
      setWorkspace((current) => current ? {
        ...current,
        candidates: current.candidates.map((candidate) => candidate.proposal.id === result.candidate.proposal.id ? result.candidate : candidate),
      } : current);
      setDecision(null);
      setDecisionNote('');
      if (result.approval_request_id) {
        setApprovalId(result.approval_request_id);
        setNotice('Sent to the independent publication review. It is not published or usable yet.');
      } else {
        setNotice(input.decision === 'exclude' ? 'Excluded from the active queue. The decision is recorded and reversible.' : 'Candidate returned to the active queue.');
      }
    } catch (error) {
      setNotice(errorCopy(error));
    } finally {
      setBusy(null);
    }
  };

  const addGoal = async (): Promise<void> => {
    setBusy('goal');
    setNotice(null);
    try {
      const created = await adapter.rest.createSharedIntelligenceGoal(state.workspace.id, {
        scope: goalDraft.scope,
        team_id: goalDraft.scope === 'team' ? goalDraft.team_id : null,
        title: goalDraft.title,
        detail: goalDraft.detail,
      });
      setWorkspace((current) => current ? { ...current, goals: [created, ...current.goals] } : current);
      setGoalId(created.id);
      setAddingGoal(false);
      setGoalDraft({ scope: 'workspace', team_id: '', title: '', detail: '' });
      setNotice('Goal saved. New candidate assessments can now be frozen against it.');
    } catch (error) {
      setNotice(errorCopy(error));
    } finally {
      setBusy(null);
    }
  };

  const reassess = async (): Promise<void> => {
    if (!selected || !assessmentGoalId) return;
    setBusy(`reassess:${selected.proposal.id}`);
    setNotice(null);
    try {
      const candidate = await adapter.rest.reassessSharedIntelligenceTriage(state.workspace.id, selected.proposal.id, assessmentGoalId);
      setWorkspace((current) => current ? { ...current, candidates: current.candidates.map((item) => item.proposal.id === candidate.proposal.id ? candidate : item) } : current);
      setNotice(candidate.proposal.triage_assessment?.status === 'complete'
        ? 'Jev priority refreshed against the selected goal and current authorized Library comparisons.'
        : 'The candidate was refreshed, but Jev is unavailable. It remains honestly unranked.');
    } catch (error) {
      setNotice(errorCopy(error));
    } finally {
      setBusy(null);
    }
  };

  if (!admin) return <EmptyState icon="context" title="Admin decision required" detail="Shared Intelligence triage is visible only to workspace Admins. Members can still prepare and share their own candidates from Library." />;
  if (!workspace && busy === 'load') return <Skeleton rows={7} label="Loading Shared Intelligence triage" />;
  if (!workspace) return <EmptyState icon="context" title="Shared Intelligence is unavailable" detail={notice} />;

  const counts = workspace.candidates.reduce((result, candidate) => ({
    ...result, [candidate.proposal.triage_status]: (result[candidate.proposal.triage_status] ?? 0) + 1,
  }), {} as Record<string, number>);

  return (
    <div className="scroll admin-intelligence-scroll">
      <div className="app-body admin-intelligence">
        <div className="admin-intelligence-title">
          <div><h1 className="display-32">Shared Intelligence</h1><p>Prioritize owner-shared lessons against the outcomes your team is trying to improve. Jev ranks attention; people decide what is reviewed and published.</p></div>
          <Button onClick={() => setAddingGoal((value) => !value)}>{addingGoal ? 'Cancel' : 'Add goal'}</Button>
        </div>

        <AnimatePresence initial={false}>
          {addingGoal && <motion.form className="admin-goal-form" onSubmit={(event) => { event.preventDefault(); void addGoal(); }} initial={reduceMotion ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}>
            <label><span>Scope</span><select value={goalDraft.scope} onChange={(event) => setGoalDraft({ ...goalDraft, scope: event.target.value as 'workspace' | 'team', team_id: '' })}><option value="workspace">Organization</option><option value="team">Team</option></select></label>
            {goalDraft.scope === 'team' && <label><span>Team</span><select required value={goalDraft.team_id} onChange={(event) => setGoalDraft({ ...goalDraft, team_id: event.target.value })}><option value="">Select team</option>{workspace.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}
            <label><span>Goal</span><input required maxLength={200} value={goalDraft.title} onChange={(event) => setGoalDraft({ ...goalDraft, title: event.target.value })} placeholder="Reduce partner review rework" /></label>
            <label className="wide"><span>What success means</span><textarea required maxLength={1000} rows={3} value={goalDraft.detail} onChange={(event) => setGoalDraft({ ...goalDraft, detail: event.target.value })} /></label>
            <Button primary type="submit" disabled={busy === 'goal'}>{busy === 'goal' ? 'Saving…' : 'Save goal'}</Button>
          </motion.form>}
        </AnimatePresence>

        <div className="admin-intelligence-toolbar">
          <label><span>Filter by frozen goal</span><select value={goalId} onChange={(event) => setGoalId(event.target.value)}><option value="all">All goals</option>{workspace.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>
          <div className="admin-intelligence-filters" role="group" aria-label="Triage status">
            {(['queued', 'included', 'excluded', 'all'] as const).map((value) => <button type="button" key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{value === 'all' ? 'All' : `${value[0]!.toUpperCase()}${value.slice(1)} · ${counts[value] ?? 0}`}</button>)}
            <button type="button" aria-pressed={period === '30'} onClick={() => setPeriod(period === '30' ? 'all' : '30')}>{period === '30' ? 'Last 30 days' : 'All time'}</button>
          </div>
        </div>
        {notice && <div className="admin-intelligence-notice" role="status"><span>{notice}</span>{approvalId && <Button small onClick={() => nav(REQ(approvalId))}>Open review</Button>}</div>}

        <div className="admin-intelligence-workspace">
          <section className="admin-intelligence-queue" aria-label="Ranked Shared Intelligence candidates">
            <div className="admin-intelligence-queue-head"><span>Ranked candidates</span><span>Priority</span></div>
            {candidates.length === 0 ? <EmptyState icon="skill" title="No candidates in this view" detail="Members share candidates from Library after approving the exact excerpts." /> : candidates.map((candidate) => {
              const active = candidate.proposal.id === selectedId;
              const reasons = candidate.proposal.triage_assessment?.reason_codes.slice(0, 3) ?? [];
              return <motion.button layout={!reduceMotion} type="button" className="admin-intelligence-row" data-active={active} aria-pressed={active} key={candidate.proposal.id} onClick={() => setSelectedId(candidate.proposal.id)}>
                <span className="admin-intelligence-score">{score(candidate)}</span>
                <span className="admin-intelligence-row-body"><strong>{candidate.proposal.title}</strong><small>{candidate.proposal.audiences.map((team) => team.name).join(' + ')} · {candidate.proposal.evidence.length} approved excerpt{candidate.proposal.evidence.length === 1 ? '' : 's'}</small><span className="admin-intelligence-reasons">{reasons.map((reason) => <i key={reason}>{REASON_LABELS[reason]}</i>)}</span><q>{candidate.proposal.evidence[0]?.approved_excerpt}</q></span>
              </motion.button>;
            })}
          </section>

          <section className="admin-intelligence-detail" aria-label="Candidate detail">
            {!selected ? <EmptyState icon="skill" title="Select a candidate" /> : <motion.div key={selected.proposal.id} initial={reduceMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}>
              <div className="admin-intelligence-detail-head"><span className="admin-intelligence-score large">{score(selected)}</span><div><h2>{selected.proposal.title}</h2><p>{recommendation(selected)}{selected.proposal.triage_assessment?.confidence !== null && selected.proposal.triage_assessment?.confidence !== undefined ? ` · ${Math.round(selected.proposal.triage_assessment.confidence * 100)}% assessment confidence` : ''} · rubric {selected.proposal.triage_assessment?.rubric_version ?? 'unavailable'}</p></div></div>
              {selected.assessment_stale && <div className="admin-intelligence-stale" role="status">This priority is stale ({selected.stale_reason?.replaceAll('_', ' ')}). Reassess before sending it for review.</div>}
              {selected.proposal.triage_status === 'queued' && <div className="admin-intelligence-actions"><Button primary disabled={!!busy || selected.assessment_stale} onClick={() => void act({ decision: 'include', note: '' })}>Send for review</Button><Button disabled={!!busy} onClick={() => setDecision('exclude')}>Exclude…</Button></div>}
              {selected.proposal.triage_status === 'excluded' && <div className="admin-intelligence-actions"><Button primary disabled={!!busy} onClick={() => void act({ decision: 'reopen', note: 'Reopened for Admin triage.' })}>Reopen candidate</Button></div>}
              <p className="admin-intelligence-consequence">Sending for review freezes this candidate for an independent human decision. It does not publish it or make it usable by an agent.</p>
              {selected.proposal.triage_status === 'queued' && <div className="admin-intelligence-reassess"><label><span>Assessment goal</span><select value={assessmentGoalId} onChange={(event) => setAssessmentGoalId(event.target.value)}>{workspace.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label><Button disabled={!assessmentGoalId || !!busy} onClick={() => void reassess()}>{busy === `reassess:${selected.proposal.id}` ? 'Assessing…' : 'Reassess'}</Button></div>}
              {decision === 'exclude' && <div className="admin-intelligence-decision"><label><span>Why exclude this candidate?</span><textarea autoFocus required maxLength={1000} rows={3} value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} /></label><div><Button onClick={() => setDecision(null)}>Cancel</Button><Button primary disabled={!decisionNote.trim() || !!busy} onClick={() => void act({ decision: 'exclude', note: decisionNote })}>Record exclusion</Button></div></div>}
              <div className="admin-intelligence-card"><h3>Goal used for this assessment</h3><strong>{selected.goal.title}</strong><p>{selected.goal.detail}</p><small>{selected.goal.team_name ?? 'Organization'} · revision {selected.goal.revision} · {selected.goal.content_sha256.slice(0, 12)}…</small></div>
              <div className="admin-intelligence-card"><h3>Owner rationale</h3><p>{selected.proposal.rationale}</p><small>Submitted by {selected.submitted_by.name} · assessed {selected.proposal.triage_assessment ? new Date(selected.proposal.triage_assessment.assessed_at).toLocaleString() : 'unavailable'}</small></div>
              <div className="admin-intelligence-card"><h3>Approved evidence</h3>{selected.proposal.evidence.map((evidence) => <blockquote key={evidence.id}><small>{evidence.session_title} · {new Date(evidence.run_ended_at).toLocaleDateString()} · {evidence.source_message_role === 'user' ? 'human assertion' : 'agent response'}</small><p>{evidence.approved_excerpt}</p></blockquote>)}</div>
              <div className="admin-intelligence-card"><h3>Library comparisons used for novelty</h3>{selected.library_comparisons.length === 0 ? <p className="meta">No authorized Library source was available for this audience.</p> : selected.library_comparisons.map((comparison) => <div className="admin-intelligence-comparison" key={comparison.version_id}>{comparison.access === 'available' ? <><strong>{comparison.title}</strong><p>{comparison.summary}</p></> : <p>Readable source access was withdrawn. Only immutable version hash {comparison.version_sha256.slice(0, 12)}… remains in the assessment record.</p>}</div>)}</div>
              {selected.decision_note && <div className="admin-intelligence-card"><h3>Latest Admin decision note</h3><p>{selected.decision_note}</p></div>}
              <details className="admin-intelligence-disclosure"><summary>See Jev signals and model record</summary>{selected.proposal.triage_assessment?.axes ? <div className="admin-intelligence-signals">{Object.entries(selected.proposal.triage_assessment.axes).map(([axis, value]) => <span key={axis}><i>{AXIS_LABELS[axis as keyof typeof AXIS_LABELS]}</i><b>{value.score.toFixed(1)} / 3</b></span>)}</div> : <p>Jev assessment unavailable. This candidate is deliberately unranked.</p>}</details>
              <details className="admin-intelligence-disclosure"><summary>What is shared with Admin and Jev</summary><p>{workspace.data_boundary}</p></details>
            </motion.div>}
          </section>
        </div>
      </div>
    </div>
  );
}
