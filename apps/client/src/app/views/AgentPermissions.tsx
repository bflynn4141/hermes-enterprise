// These switches govern registered tool operations, never grant new capabilities.
//
// `ApprovalSwitches` is shared by the Agent tab and Admin → Agents. An Admin
// may change the switches on any agent; the waiting actions below them are the
// agent's own run content, and the server leaves them out
// (`pending_approvals_visible: false`) when this viewer may not read that work.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentPermissions as Permissions } from '@hermes/shared';
import { useAdapter, useAppState, useIsAdmin } from '../store-context.js';
import { Button, EmptyState, Skeleton } from '../ui/primitives.js';
import { AgentHead, AgentTabsRow } from './Agent.js';
import { agentName } from '../selectors.js';
import { readableTool } from '../tool-copy.js';
import './agent-settings.css';

export function AgentPermissions() {
  const state = useAppState();
  return <div className="scroll"><div className="app-body agent-settings">
    <AgentHead /><AgentTabsRow value="permissions" />
    <div className="agent-settings-heading"><div><h2 className="display-28">Human approval</h2><p className="meta">Choose when {agentName(state)} should ask you before taking an action.</p></div></div>
    {state.agent.id && <ApprovalSwitches key={`${state.workspace.id}:${state.agent.id}`} workspaceId={state.workspace.id} agentId={state.agent.id} agentName={agentName(state)} />}
  </div></div>;
}

/** Read the server's `reason` without trusting the shape of what was thrown. */
function reasonOf(caught: unknown): string {
  return (caught as { reason?: string }).reason ?? '';
}

export function ApprovalSwitches({ workspaceId, agentId, agentName: name }: { workspaceId: string; agentId: string; agentName: string }) {
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reauth, setReauth] = useState(false);
  const [status, setStatus] = useState('');
  const lock = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (lock.current) return;
    const version = ++generation.current;
    const data = await adapter.rest.agentPermissions(workspaceId, agentId);
    if (mounted.current && version === generation.current) setPermissions(data);
  }, [adapter, workspaceId, agentId]);
  useEffect(() => {
    void refresh().catch(() => { if (mounted.current) setError('Could not load permissions.'); });
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh().catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const mutate = async (id: string, work: () => Promise<Permissions>, message: string) => {
    if (!admin || lock.current) return;
    lock.current = true; generation.current++; setBusy(id); setError(''); setReauth(false); setStatus('Saving…');
    try {
      const saved = await work();
      if (mounted.current) { setPermissions(saved); setStatus(message); }
    } catch (caught) {
      if (mounted.current) {
        const reason = reasonOf(caught);
        setStatus('');
        // Changing another member's agent needs a recent sign-in. The change is
        // not replayed after it: the person clicks the switch again.
        if (reason === 'reauth_required') { setReauth(true); setError('Changing another person’s agent needs a recent sign-in.'); }
        else setError(/stale|conflict/.test(reason) ? 'Permissions changed elsewhere. Review the latest settings and try again.' : 'Could not save. Your last confirmed settings are still shown.');
      }
    } finally {
      lock.current = false;
      if (mounted.current) { setBusy(null); void refresh().catch(() => undefined); }
    }
  };
  const stepUp = () => {
    const url = adapter.auth.stepUpUrl(window.location.href, 'agent_governance');
    if (url) window.location.assign(url);
  };
  return <>
    {error && <p className="agent-settings-error" role="alert">{error} {reauth
      ? <Button link onClick={stepUp}>Sign in again</Button>
      : <Button link onClick={() => { setError(''); void refresh().catch(() => setError('Could not load permissions.')); }}>Reload</Button>}</p>}
    {!permissions && !error && <Skeleton rows={3} />}
    {permissions && <>
      <div className="agent-settings-heading"><span className="agent-settings-title">Supported actions</span><span className="meta agent-approval-column-label">Require human approval</span></div>
      {permissions.operations.length === 0 && <EmptyState icon="skill" title="No configurable actions" detail="Assign a supported skill to this agent to see its actions here." />}
      <div>{permissions.operations.map((operation) => <div className="agent-settings-row" key={operation.id}>
        <div><span className="agent-settings-title">{operation.label}</span><p className="meta" id={`permission-${agentId}-${operation.id}`}>{operation.description}</p></div>
        <div className="agent-approval-toggle"><span className="meta agent-approval-mobile-label">Human approval</span><span className="meta">{operation.require_human_approval ? 'On' : 'Off'}</span><button type="button" role="switch" aria-label={`Require human approval: ${operation.label}`} aria-describedby={`permission-${agentId}-${operation.id}`} aria-checked={operation.require_human_approval} disabled={!admin || busy !== null} onClick={() => {
          void mutate(operation.id, () => adapter.rest.setAgentPermission(workspaceId, agentId, { revision: permissions.revision, operation_id: operation.id, require_human_approval: !operation.require_human_approval }), 'Saved');
        }}><span className="agent-approval-track" /></button></div>
      </div>)}</div>
      <div><p className="meta">{admin ? 'Changes save automatically.' : 'Read-only. An admin can change approval settings.'}</p><p className="meta">On: {name} asks first. Off: {name} can do this without asking.</p><p className="meta">Existing review requirements and data access still apply. Changing a switch does not approve a waiting action.</p>
        {!permissions.pending_approvals_visible && <p className="meta">Actions already waiting for approval are part of {name}’s work, so they are not shown here.</p>}</div>
      <div role="status" aria-live="polite" className="agent-settings-status">{status}</div>
      {permissions.pending_approvals.length > 0 && <section aria-label="Actions waiting for approval"><h2 className="section-title">Waiting for your approval</h2>{permissions.pending_approvals.map((approval) => <div className="agent-settings-editor agent-pending-approval" key={approval.id}>
        <h3>{permissions.operations.find((operation) => operation.id === approval.operation_id)?.label ?? 'Requested action'}</h3><span className="meta">{readableTool(approval.tool_name, true)} · {new Date(approval.created_at).toLocaleString()}</span><ApprovalArguments value={approval.arguments} /><p className="meta">Approval applies only to this exact action in this run.</p>
        {admin ? <div className="agent-settings-actions"><Button primary disabled={busy !== null} onClick={() => { void mutate(approval.id, () => adapter.rest.decideOperationApproval(workspaceId, agentId, approval.id, 'approved'), 'Action approved once.'); }}>Approve once</Button><Button disabled={busy !== null} onClick={() => { void mutate(approval.id, () => adapter.rest.decideOperationApproval(workspaceId, agentId, approval.id, 'denied'), 'Action declined.'); }}>Decline</Button></div> : <p className="meta">An admin must approve this action.</p>}
      </div>)}</section>}
    </>}
  </>;
}

/** Each top-level argument as a labelled value; the exact JSON stays one click away. */
function ApprovalArguments({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  const text = (item: unknown): string => typeof item === 'string' ? item : typeof item === 'number' || typeof item === 'boolean' ? String(item) : item == null ? '—' : JSON.stringify(item);
  return <div className="agent-approval-arguments">
    {entries.length === 0 ? <p className="meta">No arguments.</p> : <dl>{entries.map(([key, item]) => <div key={key}><dt>{key.replace(/[_-]+/g, ' ')}</dt><dd>{text(item)}</dd></div>)}</dl>}
    <details><summary>Exact arguments</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
  </div>;
}
