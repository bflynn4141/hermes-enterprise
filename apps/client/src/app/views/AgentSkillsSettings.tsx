// Selected-agent settings. Keep drafts local and preserve them on failed saves.
import { useEffect, useRef, useState } from 'react';
import type { EnterpriseSkillAssignment, InstructionVersion, SkillVersion } from '@hermes/shared';
import { useAdapter, useAppState, useIsAdmin, useNav } from '../store-context.js';
import { agentName } from '../selectors.js';
import { Button } from '../ui/primitives.js';
import { AgentHead, AgentTabsRow } from './Agent.js';
import { SkillAssignmentEditor } from './Workspace.js';
import './agent-skills-settings.css';

// In-memory only: section navigation preserves a draft without persisting
// instruction text to disk or sharing it across signed-in identities.
const instructionDrafts = new Map<string, { text: string; expectedId: string | null }>();

function errorCopy(error: unknown): string {
  const reason = (error as { reason?: string }).reason;
  if (reason === 'stale_revision') return 'This changed in another window. Your draft is kept. Reload the current version and review it before saving again.';
  if (reason === 'not_admin') return 'Only workspace administrators can change these settings.';
  return 'Could not save that change. Your draft is kept. Try again.';
}

export function AgentSkillsSettings() {
  const state = useAppState();
  // Remount the form on agent/workspace changes: no old agent draft or late
  // response can be shown as another agent’s configuration.
  return <SkillsSettings key={`${state.user.id}:${state.workspace.id}:${state.agent.id}`} />;
}

function SkillsSettings() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const nav = useNav();
  const agent = agentName(state);
  const agentId = state.agent.id;
  const workspaceId = state.workspace.id;
  const draftKey = `${state.user.id}:${workspaceId}:${agentId}`;
  const restoredDraft = instructionDrafts.get(draftKey);
  const [instructions, setInstructions] = useState<InstructionVersion[]>([]);
  const [skills, setSkills] = useState<SkillVersion[]>([]);
  const [assignments, setAssignments] = useState<EnterpriseSkillAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(!!restoredDraft);
  const [draft, setDraft] = useState(restoredDraft?.text ?? '');
  const [expectedId, setExpectedId] = useState<string | null>(restoredDraft?.expectedId ?? null);
  const [saving, setSaving] = useState(false);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const current = instructions.find((row) => row.state === 'current');
  const proposals = instructions.filter((row) => row.state === 'proposed');

  useEffect(() => {
    if (!agentId) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    void Promise.all([
      adapter.rest.listInstructions(workspaceId, agentId),
      adapter.rest.listSkills(workspaceId, agentId),
      adapter.rest.listSkillAssignments(workspaceId, agentId),
    ]).then(([versions, library, workflows]) => {
      if (!active) return;
      setInstructions(versions.items);
      setSkills(library.items.filter((row) => !row.id.startsWith('managed:')));
      setAssignments(workflows.items);
      setReady(true);
      setError(null);
    }).catch(() => { if (active) setError('Could not load agent settings. Try again.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [adapter.rest, workspaceId, agentId, refresh]);

  useEffect(() => {
    if (!editing || draft === (current?.text ?? '')) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [editing, draft, current?.text]);

  const closeEditor = () => { instructionDrafts.delete(draftKey); setEditing(false); requestAnimationFrame(() => editButton.current?.focus()); };
  const save = async () => {
    if (!agentId || saving) return;
    setSaving(true); setError(null); setStatus('');
    try {
      const next = await adapter.rest.saveInstruction(workspaceId, agentId, { text: draft, expected_current_id: expectedId });
      setInstructions((previous) => [next, ...previous.map((row) => row.state === 'current' ? { ...row, state: 'saved' as const } : row)]);
      closeEditor(); setStatus('Saved. New runs will use these instructions.');
    } catch (caught) { setError(errorCopy(caught)); }
    finally { setSaving(false); }
  };
  const decide = async (proposal: InstructionVersion, verdict: 'accept' | 'discard') => {
    if (!agentId || saving) return;
    setSaving(true); setError(null); setStatus('');
    try {
      if (verdict === 'accept') await adapter.rest.acceptInstruction(workspaceId, proposal.id, agentId);
      else await adapter.rest.discardInstruction(workspaceId, proposal.id, agentId);
      setStatus(verdict === 'accept' ? 'Instructions saved for new runs.' : 'Suggestion discarded.');
      setRefresh((value) => value + 1);
    } catch (caught) { setError(errorCopy(caught)); }
    finally { setSaving(false); }
  };

  return <div className="scroll"><div className="app-body iris-skills-settings">
    <AgentHead /><AgentTabsRow value="skills" />
    <div className="iris-skills-heading"><div><h2 className="display-28">How {agent} works</h2><p className="meta">Manage reusable workflows and the instructions {agent} follows.</p></div>
      <Button aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>Browse skills</Button></div>
    {loading && <p role="status" className="meta">Loading agent settings…</p>}
    {error && <div role="alert" className="iris-skills-error"><p>{error}</p><Button disabled={saving} onClick={() => setRefresh((value) => value + 1)}>Reload current settings</Button></div>}
    {status && <p role="status" className="meta">{status}</p>}
    {!loading && !agentId && <p>No agent selected.</p>}
    {!loading && ready && agentId && <>
      <section className="iris-skills-instructions" aria-label={`Instructions for ${agent}`}>
        <div className="iris-skills-heading"><div><h2 className="display-28">Instructions for {agent}</h2><p className="meta">{current ? `${current.provenance ?? 'Saved instructions'} · ${new Date(current.created_at).toLocaleDateString()}` : 'No standing instructions saved yet'}</p></div>
          {!editing && <button className="btn" ref={editButton} disabled={!admin || saving} onClick={() => { setDraft(current?.text ?? ''); setExpectedId(current?.id ?? null); instructionDrafts.set(draftKey, { text: current?.text ?? '', expectedId: current?.id ?? null }); setEditing(true); setStatus(''); }}>Review &amp; edit</button>}</div>
        {editing ? <form className="iris-skills-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label htmlFor="iris-instruction-text">Standing instructions</label>
          <textarea autoFocus id="iris-instruction-text" value={draft} maxLength={8000} rows={7} disabled={saving || !admin} onChange={(event) => { setDraft(event.target.value); instructionDrafts.set(draftKey, { text: event.target.value, expectedId }); }} />
          <p className="meta">Applies to new runs only. This does not grant access to tools or data.</p>
          {expectedId !== (current?.id ?? null) && <div className="iris-skills-error"><p>The current instructions changed. Compare the saved text below with your draft.</p><pre>{current?.text}</pre><Button onClick={() => { setExpectedId(current?.id ?? null); instructionDrafts.set(draftKey, { text: draft, expectedId: current?.id ?? null }); }}>I’ve reviewed the current version</Button></div>}
          <div className="iris-skills-actions"><Button disabled={saving} onClick={closeEditor}>Cancel</Button><Button primary type="submit" disabled={!admin || saving || !draft.trim() || expectedId !== (current?.id ?? null)}>{saving ? 'Saving…' : 'Save instructions'}</Button></div>
        </form> : <><p className="iris-skills-copy">{current?.text ?? `Add instructions about how ${agent} should work.`}</p><p className="meta">Instruction changes apply to future runs.</p></>}
      </section>
      {proposals.map((proposal) => <section className="iris-skills-instructions" key={proposal.id} aria-label="Proposed instructions"><h3 className="section-title">Suggested instruction change</h3><p className="meta">{proposal.provenance ?? 'Proposed by a run'} · Not saved</p><details><summary>Compare with current instructions</summary><p className="iris-skills-copy">{current?.text ?? proposal.before ?? 'No current instructions'}</p></details><p className="iris-skills-copy">{proposal.text}</p><div className="iris-skills-actions"><Button disabled={!admin || saving || editing} onClick={() => void decide(proposal, 'discard')}>Discard</Button><Button primary disabled={!admin || saving || editing} onClick={() => void decide(proposal, 'accept')}>Accept for future runs</Button></div></section>)}
      <section><h2 className="display-28">Assigned skills</h2><p className="meta">Each skill runs within {agent}’s permissions.</p>
        {!assignments.length && !skills.some((row) => row.adopted) && <p className="meta">No skills assigned yet.</p>}
        {assignments.map((assignment) => <div key={assignment.id}><div className="iris-skills-row"><div><h3>{assignment.name}</h3><p className="meta">{assignment.description} · {assignment.version}</p><p className="meta">{assignment.team?.name ?? 'Workspace'} · {assignment.agent_name ?? agent} · {assignment.state === 'active' ? 'Active' : 'Paused'} · revision {assignment.revision}</p></div><Button disabled={!admin || saving} aria-expanded={configuring === assignment.id} onClick={() => setConfiguring(configuring === assignment.id ? null : assignment.id)}>{configuring === assignment.id ? 'Close' : 'Configure →'}</Button></div>
          {configuring === assignment.id && <SkillAssignmentEditor key={`${assignment.id}:${assignment.revision}`} assignment={assignment} onCancel={() => setConfiguring(null)} onSave={async (patch) => { const next = await adapter.rest.updateSkillAssignment(workspaceId, agentId, assignment.id, patch); setAssignments((rows) => rows.map((row) => row.id === next.id ? next : row)); setConfiguring(null); setStatus('Skill configuration saved.'); }} />}
        </div>)}
        {skills.filter((row) => row.adopted).map((skill) => <div className="iris-skills-row" key={skill.id}><div><h3>{skill.name}</h3><p className="meta">{skill.description} · {skill.version} · Shared by {skill.shared_by}</p></div><span className="meta">In use</span></div>)}
      </section>
      {browsing && <section aria-label="Shared skills"><h2 className="display-28">Shared skills</h2>{!skills.some((row) => !row.adopted) && <p className="meta">No additional shared skills available.</p>}{skills.filter((row) => !row.adopted).map((skill) => <div className="iris-skills-row" key={skill.id}><div><h3>{skill.name} · {skill.version}</h3><p className="meta">{skill.description} · Shared by {skill.shared_by}</p>{skill.detail && <details><summary>Read skill</summary><p className="iris-skills-copy">{skill.detail}</p></details>}</div><Button disabled={!admin || saving} onClick={() => { setSaving(true); setError(null); void adapter.rest.adoptSkill(workspaceId, skill.id, agentId).then((next) => { setSkills((rows) => rows.map((row) => row.id === next.id ? next : row)); setStatus('Skill added.'); }).catch((caught) => setError(errorCopy(caught))).finally(() => setSaving(false)); }}>Add to {agent}</Button></div>)}</section>}
      <div className="iris-skills-heading"><p className="meta">Choose which actions need your approval.</p><Button quiet onClick={() => nav({ section: 'agents', view: 'permissions' })}>Open permissions →</Button></div>
      {!admin && <p className="meta">Read-only. Only workspace administrators can change these settings.</p>}
    </>}
  </div></div>;
}
