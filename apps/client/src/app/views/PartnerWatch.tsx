// The server owns source eligibility, admission and spending. A click is never
// a completed check; only recorded check results and review links appear here.
import { useCallback, useEffect, useRef, useState } from 'react';
import { REQ, partnerWatchUpdateSchema, type PartnerWatch, type PartnerWatchUpdate } from '@hermes/shared';
import { useAdapter, useAppState, useNav, useStore } from '../store-context.js';
import { LIST_KEYS } from '../selectors.js';
import { uuid } from '../../model/store.js';
import { Button, Dialog, EmptyState, StatusDot, type StatusTone } from '../ui/primitives.js';
import './partner-watch.css';

const STATUS: Record<PartnerWatch['state'], { label: string; tone: StatusTone }> = {
  unconfigured: { label: 'Not set up', tone: 'muted' }, paused: { label: 'Paused', tone: 'warn' },
  ready: { label: 'Enabled', tone: 'ok' }, checking: { label: 'Checking', tone: 'working' },
  working: { label: 'Preparing review', tone: 'working' }, needs_attention: { label: 'Needs attention', tone: 'problem' },
};
const REASONS: Record<string, string> = {
  automated_triggers_disabled: 'Scheduled work is not available in this workspace yet.',
  automation_disabled: 'Scheduled work is not available in this workspace yet.',
  assignment_paused: 'An Admin paused this agent’s partner screening skill. Ask them to resume it before running checks.',
  assignment_missing: 'An Admin needs to assign the partner screening skill first.',
  unsupported_source: 'Choose a free GitHub source in the partner screening skill first.',
  source_unavailable: 'The selected GitHub source is no longer available. Choose another source.',
  not_owner: 'Only this agent’s owner can manage its partner watch.',
  agent_not_started: 'This agent needs to finish setup before it can watch for changes.',
  runtime_unavailable: 'This agent needs an available cloud connection before it can check.',
  watch_model_price_unknown: 'This model’s price could not be verified. Choose an available model in Admin → Models.',
  watch_model_budget_too_small: 'The chosen model cannot fit this check’s spending limit. Choose a compatible model in Admin → Models.',
  partner_watch_budget_cost_limit: 'The chosen model cannot fit this check’s spending limit. Choose a compatible model in Admin → Models.',
  partner_watch_budget_daily_cost_limit: 'This watch has reached its daily model spending limit.',
  partner_watch_budget_call_limit: 'This review reached its allowed model steps. Check the agent’s activity.',
  partner_watch_budget_price_unknown: 'This model’s price could not be verified. Choose an available model in Admin → Models.',
  partner_watch_authority_stale: 'This watch was paused or its settings changed. Review the current settings before trying again.',
  watch_source_unavailable: 'The selected GitHub source is no longer available. Choose another source.',
  partner_watch_paused: 'Resume this watch before running a check.',
  partner_watch_review_missing: 'This check finished without a saved review. Open the agent’s activity to see what happened.',
  provider_unavailable: 'Connect an available model in Admin → Models before checking.',
  model_budget_exhausted: 'This watch has reached its daily model spending limit.',
  budget_exceeded: 'This watch has reached its model spending limit.',
  watch_paused: 'Resume this watch before running a check.',
};
function reasonCopy(reason: string | null): string {
  if (!reason) return '';
  return REASONS[reason] ?? 'This watch cannot run yet. Check the agent’s setup and saved settings.';
}
function errorCopy(error: unknown): string {
  const reason = (error as { reason?: string }).reason;
  if (reason === 'stale_revision') return 'This watch changed in another window. Your draft is kept. Reload the current settings before saving again.';
  if (reason === 'reauth_required' || reason === 'signed_out') return 'Sign in again before changing this watch.';
  if (reason && REASONS[reason]) return REASONS[reason]!;
  return 'Could not confirm that change. Refresh the status and try again.';
}
const dollars = (value: number) => `$${value.toFixed(2)}`;
const cadence = (minutes: number) => minutes === 60 ? 'Every hour' : minutes === 1440 ? 'Every day' : `Every ${minutes / 60} hours`;
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not checked';
function resultCopy(check: PartnerWatch['last_check']): string {
  if (!check) return 'The first check will save a starting point.';
  if (check.review_id) return 'A cited review is ready in your Inbox.';
  if (check.error_code && REASONS[check.error_code]) return REASONS[check.error_code]!;
  if (check.status === 'baseline') return 'Starting point saved. Future checks will look for changes.';
  if (check.status === 'unchanged') return 'No relevant changes.';
  if (check.status === 'changed') return 'A change was found. Check the agent’s activity for its review.';
  if (check.status === 'cancelled') return 'This check was stopped.';
  if (check.status === 'failed') return check.error_code && REASONS[check.error_code] ? REASONS[check.error_code]! : 'This check could not finish. Nothing was sent.';
  return 'Checking the selected source.';
}

export function PartnerWatchCard() {
  const state = useAppState();
  return state.agent.id ? <Watch key={`${state.user.id}:${state.workspace.id}:${state.agent.id}`} agentId={state.agent.id} /> : null;
}
function Watch({ agentId }: { agentId: string }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const store = useStore();
  const workspaceId = state.workspace.id;
  const [view, setView] = useState<PartnerWatch | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const wakeKey = useRef<string | null>(null);
  const resultId = useRef<string | null>(null);
  const generation = useRef(0);
  const reading = useRef(false);
  const accept = useCallback((next: PartnerWatch) => {
    if (!mounted.current) return;
    setView(next);
    const reviewId = next.latest_review?.id ?? next.last_check?.review_id;
    if (reviewId && reviewId !== resultId.current) {
      resultId.current = reviewId;
      if (!store.getState().entities.request[reviewId]?.data) {
        adapter.invalidateList(LIST_KEYS.requests);
        adapter.invalidateList(LIST_KEYS.traces);
      }
    }
  }, [adapter, store]);
  const reload = useCallback(async () => {
    if (busyRef.current || reading.current) return;
    const currentGeneration = generation.current;
    reading.current = true;
    try {
      const next = await adapter.rest.partnerWatch(workspaceId, agentId);
      if (currentGeneration !== generation.current) return;
      accept(next);
      if (mounted.current) setError('');
    } catch { if (mounted.current && currentGeneration === generation.current) setError('Could not load the partner watch. Try again.'); }
    finally { reading.current = false; }
  }, [adapter, workspaceId, agentId, accept]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const timer = setInterval(() => { if (!document.hidden) void reload(); }, 15_000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [reload]);
  const mutate = async (body: PartnerWatchUpdate) => {
    if (busyRef.current) return;
    generation.current += 1;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const next = await adapter.rest.updatePartnerWatch(workspaceId, agentId, body);
      if (!mounted.current) return;
      accept(next); setEditing(false); setNotice(next.blocked_reason === 'assignment_paused' ? 'Watch settings saved. An Admin must resume the partner screening skill before checks can run.' : next.enabled ? 'Partner watch enabled.' : 'Partner watch paused.');
    } catch (failure) { if (mounted.current) { setError(errorCopy(failure)); throw failure; } }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const pause = () => {
    if (!view?.revision || !view.selected_source) return;
    void mutate({ revision: view.revision, enabled: !view.enabled, source_id: view.selected_source.id, interval_minutes: view.interval_minutes, ...view.budget }).catch(() => undefined);
  };
  const runNow = async () => {
    if (!view?.may_run || busyRef.current) return;
    generation.current += 1;
    busyRef.current = true; setBusy(true); setNotice(''); setError('');
    wakeKey.current ??= uuid();
    try {
      const wake = await adapter.rest.wakeAgent(workspaceId, agentId, { action: 'run_now', idempotency_key: wakeKey.current });
      wakeKey.current = null;
      if (!mounted.current) return;
      const next = await adapter.rest.partnerWatch(workspaceId, agentId);
      accept(next);
      if (wake.state === 'blocked') setError(reasonCopy(next.blocked_reason) || 'This check cannot start yet. Refresh the agent’s status and try again.');
      else setNotice(wake.state === 'idle' ? 'Check status refreshed.' : 'Check requested. Its result will appear here when it finishes.');
    } catch (failure) { if (mounted.current) setError(errorCopy(failure)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  if (!view) return error ? <section className="partner-watch" aria-label="Partner watch"><p role="alert">{error}</p><Button onClick={() => void reload()}>Try again</Button></section> : null;
  // An older deployment or an unrelated agent has no watch to show. The
  // selected agent's actual setup explains why activation is unavailable.
  const status = STATUS[view.state];
  return <section className="partner-watch" aria-label="Partner watch">
    <div className="partner-watch-head"><h2>Partner watch</h2><StatusDot {...status} /></div>
    {view.state === 'unconfigured' ? <EmptyState compact icon="skill" title="Choose a partner source" detail={reasonCopy(view.blocked_reason)} action={view.may_configure ? <Button onClick={() => setEditing(true)}>Set up watch</Button> : undefined} /> : <>
      <p className="partner-watch-source">{view.selected_source?.label ?? 'Choose a source'}</p>
      <p className="partner-watch-limits">{cadence(view.interval_minutes)} · {dollars(view.budget.max_cost_usd_per_day)} per day · {dollars(view.budget.max_cost_usd_per_run)} per check</p>
      <p className="partner-watch-result">{resultCopy(view.last_check)}</p>
      <p className="partner-watch-timing">Last check: {dateLabel(view.last_check?.checked_at ?? null)} · Next: {view.enabled && view.next_check_at ? dateLabel(view.next_check_at) : view.enabled ? 'Unavailable' : 'Paused'}</p>
      <div className="partner-watch-actions">
        {(view.latest_review?.id ?? view.last_check?.review_id) && <Button onClick={() => nav(REQ((view.latest_review?.id ?? view.last_check?.review_id)!))}>Review in Inbox</Button>}
        <Button disabled={!view.may_run || busy} onClick={() => void runNow()}>{busy ? 'Please wait…' : 'Run now'}</Button>
        {view.may_configure && view.blocked_reason !== 'assignment_paused' && <Button disabled={busy} onClick={pause}>{view.enabled ? 'Pause' : 'Resume'}</Button>}
        {view.may_configure && <Button quiet disabled={busy} onClick={() => { setError(''); setEditing(true); }}>Configure</Button>}
      </div>
      {view.blocked_reason && <p className="partner-watch-notice">{reasonCopy(view.blocked_reason)}</p>}
    </>}
    {view.execution_mode === 'simulated' && <p className="partner-watch-notice">Sample watch · Checks and reviews are simulated.</p>}
    {notice && <p className="partner-watch-notice" role="status">{notice}</p>}
    {error && !editing && <div className="partner-watch-error" role="alert">{error}<Button quiet onClick={() => void reload()}>Refresh status</Button></div>}
    {editing && <WatchEditor view={view} busy={busy} onClose={() => { if (!busy) setEditing(false); }} onSave={mutate} onReload={reload} />}
  </section>;
}
function WatchEditor({ view, busy, onClose, onSave, onReload }: { view: PartnerWatch; busy: boolean; onClose: () => void; onSave: (body: PartnerWatchUpdate) => Promise<void>; onReload: () => Promise<void> }) {
  const [sourceId, setSourceId] = useState(view.selected_source?.id ?? view.source_options[0]?.id ?? '');
  const [interval, setInterval] = useState(view.interval_minutes);
  const [perRun, setPerRun] = useState(String(view.budget.max_cost_usd_per_run));
  const [perDay, setPerDay] = useState(String(view.budget.max_cost_usd_per_day));
  const [enabled, setEnabled] = useState(view.enabled);
  const [error, setError] = useState('');
  const [reviewedRevision, setReviewedRevision] = useState(view.revision);
  const stale = reviewedRevision !== view.revision;
  const submit = async () => {
    const parsed = partnerWatchUpdateSchema.safeParse({ revision: reviewedRevision, enabled, source_id: sourceId, interval_minutes: interval, max_cost_usd_per_run: Number(perRun), max_cost_usd_per_day: Number(perDay), max_model_calls: view.budget.max_model_calls });
    if (!parsed.success) { setError('Choose a source and a daily limit that covers one check. Check limits can be $0.01–$0.25; daily limits can be $0.01–$1.00.'); return; }
    if (stale) return;
    setError('');
    try { await onSave(parsed.data); } catch (failure) { setError(errorCopy(failure)); }
  };
  return <Dialog open title="Configure partner watch" onClose={onClose} actions={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button primary disabled={busy || stale || !view.may_configure} onClick={() => void submit()}>{busy ? 'Saving…' : 'Save watch'}</Button></>}>
    <form className="partner-watch-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>GitHub source<select disabled={busy} value={sourceId} onChange={(event) => setSourceId(event.target.value)}>{view.source_options.map((source) => <option value={source.id} key={source.id}>{source.label}</option>)}</select></label>
      <label>Check every<select disabled={busy} value={interval} onChange={(event) => setInterval(Number(event.target.value))}>{![60, 360, 720, 1440].includes(interval) && <option value={interval}>{interval} minutes</option>}<option value={60}>Hour</option><option value={360}>6 hours</option><option value={720}>12 hours</option><option value={1440}>Day</option></select></label>
      <div className="partner-watch-budget-fields"><label>Model spending per check (USD)<input disabled={busy} type="number" min="0.01" max="0.25" step="0.01" value={perRun} onChange={(event) => setPerRun(event.target.value)} /></label><label>Model spending per day (USD)<input disabled={busy} type="number" min="0.01" max="1" step="0.01" value={perDay} onChange={(event) => setPerDay(event.target.value)} /></label></div>
      <label className="partner-watch-check"><input disabled={busy || view.blocked_reason === 'assignment_paused'} type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Watch for changes while you’re away</label>
      {view.blocked_reason === 'assignment_paused' && <p className="meta">An Admin paused this skill. Saving keeps your watch settings; checks stay paused.</p>}
      <p className="meta">The first check saves a starting point. Useful changes go to your Inbox; nothing is sent or granted.</p>
      {error && <div className="partner-watch-error" role="alert">{error}<Button quiet disabled={busy} onClick={() => void onReload()}>Reload current settings</Button></div>}
      {stale && <div className="partner-watch-error"><p>Current settings: {view.selected_source?.label ?? 'No source selected'} · {cadence(view.interval_minutes)} · {dollars(view.budget.max_cost_usd_per_run)} per check · {dollars(view.budget.max_cost_usd_per_day)} per day · {view.enabled ? 'Enabled' : 'Paused'}.</p><Button disabled={busy} onClick={() => { setReviewedRevision(view.revision); setError(''); }}>I’ve reviewed the current settings</Button></div>}
    </form>
  </Dialog>;
}
