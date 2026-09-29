// Saved proposals stay visibly inactive; editing cannot activate a payment path.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RoleSpendingDraft } from '@hermes/shared';
import { useAdapter, useAppState } from '../store-context.js';
import { Button, Dialog, EmptyState, Skeleton } from '../ui/primitives.js';
import { AdminSettingsCard } from './AdminDetailLayout.js';
import { useStepUp } from './use-step-up.js';
import { formatUsdcBaseUnits, roleSpendingFields, roleSpendingPolicyFromFields, type RoleSpendingFields } from './role-spending-form.js';
import './role-spending.css';

export function RoleSpendingCard({ roleId, roleName }: { roleId: string; roleName: string }) {
  const state = useAppState();
  const adapter = useAdapter();
  const [record, setRecord] = useState<RoleSpendingDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setLoadError(false);
    try {
      const next = await adapter.rest.getRoleSpendingDraft(state.workspace.id, roleId);
      if (current === generation.current) setRecord(next);
    } catch { if (current === generation.current) setLoadError(true); }
    finally { if (current === generation.current) setLoading(false); }
  }, [adapter, state.workspace.id, roleId]);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);
  const policy = record?.policy;
  return <>
    <AdminSettingsCard title="Spending limits" description="Save limits for a future payment setup."
      footer={record && !loadError && !loading && policy ? <>
        <p role="status">{saved ? 'Draft saved · Not active' : 'Not active'}</p>
        <Button onClick={() => { setSaved(false); setEditing(true); }}>Edit draft</Button>
      </> : undefined}>
      {loading ? <Skeleton rows={2} label="Loading spending limits" />
        : loadError ? <div role="alert" className="role-spending-error"><p>Could not load spending limits.</p><Button onClick={() => void load()}>Try again</Button></div>
          : policy ? <dl className="role-spending-rows">
            <div><dt>Per transfer</dt><dd>{formatUsdcBaseUnits(policy.max_transfer_base_units)} USDC</dd></div>
            <div><dt>Recipients</dt><dd>{policy.allowed_recipients.length} allowed</dd></div>
            <div><dt>Human approvals</dt><dd>{policy.human_approvals}</dd></div>
            {policy.future_period_limits.length > 0 && <div><dt>Period limits</dt><dd>Planned · Not enforced</dd></div>}
          </dl>
            : <EmptyState compact icon="context" title="No spending draft" detail="Payment limits are not active."
              action={<Button onClick={() => { setSaved(false); setEditing(true); }}>Create draft</Button>} />}
    </AdminSettingsCard>
    {editing && record && <SpendingDialog roleId={roleId} roleName={roleName} initial={record}
      onClose={() => setEditing(false)} onReloaded={setRecord} onSaved={(next) => { setRecord(next); setSaved(true); setEditing(false); }} />}
  </>;
}

function SpendingDialog({ roleId, roleName, initial, onClose, onSaved, onReloaded }: {
  roleId: string; roleName: string; initial: RoleSpendingDraft; onClose: () => void;
  onSaved: (value: RoleSpendingDraft) => void; onReloaded: (value: RoleSpendingDraft) => void;
}) {
  const state = useAppState();
  const adapter = useAdapter();
  const stepUp = useStepUp('workspace_roles');
  const formId = useId();
  const [fields, setFields] = useState<RoleSpendingFields>(() => roleSpendingFields(initial.policy));
  const [revision, setRevision] = useState(initial.revision);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reason = (problem as { reason?: string } | null)?.reason;
  const field = (name: keyof RoleSpendingFields, value: string) => {
    setFields((previous) => ({ ...previous, [name]: value })); setValidation(null); setReloaded(false);
  };
  const close = () => { if (!pending) onClose(); };
  const save = async () => {
    if (pending || reloadRequired) return;
    let policy;
    try { policy = roleSpendingPolicyFromFields(fields); }
    catch (error) { setValidation((error as Error).message); return; }
    setPending(true); setProblem(null); setValidation(null);
    try {
      const next = await adapter.rest.putRoleSpendingDraft(state.workspace.id, roleId, { expected_revision: revision, policy });
      if (mounted.current) onSaved(next);
    } catch (error) {
      if (mounted.current) {
        setProblem(error);
        const refusal = (error as { reason?: string } | null)?.reason;
        setReloadRequired(refusal === 'revision_conflict' || !['reauth_required', 'bad_spending_policy', 'admin_required'].includes(refusal ?? ''));
      }
    } finally { if (mounted.current) setPending(false); }
  };
  const reload = async () => {
    setPending(true);
    try {
      const latest = await adapter.rest.getRoleSpendingDraft(state.workspace.id, roleId);
      if (mounted.current) {
        setFields(roleSpendingFields(latest.policy)); setRevision(latest.revision);
        setProblem(null); setValidation(null); setReloadRequired(false); setReloaded(true);
        onReloaded(latest);
      }
    } catch (error) { if (mounted.current) setProblem(error); }
    finally { if (mounted.current) setPending(false); }
  };
  return <Dialog open title={`${roleName} spending draft`} onClose={close} actions={<>
    <Button disabled={pending} onClick={close}>Cancel</Button>
    <Button type="submit" form={formId} primary disabled={pending || reloadRequired}>{pending ? 'Please wait…' : 'Save draft'}</Button>
  </>}>
    <p className="meta">USDC on Base · Saving does not activate payments or limits.</p>
    <form id={formId} className="role-spending-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset disabled={pending}>
        <legend className="sr-only">Proposed spending limits</legend>
        <label className="skill-config-field"><span>Per transfer · USDC</span>
          <input inputMode="decimal" maxLength={80} value={fields.perTransfer} onChange={(event) => field('perTransfer', event.target.value)} autoComplete="off" />
        </label>
        <label className="skill-config-field"><span>Allowed recipients</span>
          <textarea className="admin-roles-textarea" rows={3} maxLength={4400} spellCheck={false} value={fields.recipients}
            onChange={(event) => field('recipients', event.target.value)} placeholder="One lowercase wallet address per line" />
        </label>
        <label className="skill-config-field"><span>Human approvals</span>
          <input inputMode="numeric" maxLength={2} value={fields.approvals} onChange={(event) => field('approvals', event.target.value)} />
        </label>
        <details className="role-spending-future">
          <summary>Future period limits</summary>
          <p className="meta">Planned only; daily and monthly limits are not implemented.</p>
          <div className="role-spending-periods">
            <label className="skill-config-field"><span>Daily · USDC, optional</span>
              <input inputMode="decimal" maxLength={80} value={fields.daily} onChange={(event) => field('daily', event.target.value)} />
            </label>
            <label className="skill-config-field"><span>Monthly · USDC, optional</span>
              <input inputMode="decimal" maxLength={80} value={fields.monthly} onChange={(event) => field('monthly', event.target.value)} />
            </label>
          </div>
        </details>
      </fieldset>
    </form>
    {validation && <p className="role-spending-error" role="alert">{validation}</p>}
    {problem !== null && <div className="role-spending-error" role="alert">
      <p>{reason === 'revision_conflict' ? 'This draft changed elsewhere. Your edits are still here; reload to use the latest saved version.'
        : stepUp.needsSignIn(problem) ? 'Saving a draft needs a recent sign-in.'
          : reason === 'admin_required' ? 'An Admin must save this draft.'
            : 'Could not confirm the save. Your edits are still here.'}</p>
      {stepUp.needsSignIn(problem) && <Button link onClick={stepUp.signIn}>Sign in again</Button>}
      {reloadRequired && <Button disabled={pending} onClick={() => void reload()}>Reload saved draft</Button>}
    </div>}
    {reloaded && <p className="meta" role="status">Latest saved draft loaded.</p>}
  </Dialog>;
}
