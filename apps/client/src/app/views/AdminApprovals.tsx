// Admin → Approvals: who approves each business decision, and each action
// that follows one (decisions C93–C95). Invoices and payments may use a
// different rule above an amount.
//
// These are business approvals (an invoice, a payment, a signature), not the
// command safety checks a Hermes agent asks for before running something; the
// page says so first. The rules live on the server, which also enforces them;
// this page reads and writes them and explains them in plain words. Writes need
// a recent sign-in, like changing a member's roles.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ADMIN, MAX_APPROVALS, type ApprovalRoute, type ApprovalRouteKey, type ApprovalRouteRule, type ApprovalThreshold, type WorkspaceRole } from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Button, EmptyState, Skeleton, Toggle } from '../ui/primitives.js';
import { AdminSettingsCard } from './AdminDetailLayout.js';
import { roleHolders, sortRoles } from './AdminRoles.js';
import { useWorkspaceLists } from './lists.js';
import {
  ADMIN_APPROVALS_VIEW,
  AMOUNT_PROBLEM,
  APPROVALS_LIVE,
  APPROVALS_SCOPE,
  CURRENCY_PROBLEM,
  NO_APPROVER_MESSAGE,
  OTHER_CURRENCY_HINT,
  amountToMinor,
  approvalRouteErrorMessage,
  canRequireEachGroup,
  minorToAmount,
  needsSignIn,
  requesterQuestion,
  roleNameMap,
  ruleSummary,
  sameRouteRules,
  settleRule,
  splitRoutes,
  unheldRoles,
  unheldWarning,
  validCurrency,
} from './approval-routes.js';
import './admin-roles.css';
import './admin-approvals.css';

function Problem({ error }: { error: unknown }) {
  const adapter = useAdapter();
  const stepUp = () => {
    const url = adapter.auth.stepUpUrl(window.location.href, 'approval_routes');
    if (url) window.location.assign(url);
  };
  return <p className="admin-roles-problem" role="alert">
    {approvalRouteErrorMessage(error)} {needsSignIn(error) && <Button link onClick={stepUp}>Sign in again</Button>}
  </p>;
}

export function AdminApprovals({ routeKey }: { routeKey: string | null }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const [routes, setRoutes] = useState<ApprovalRoute[] | null>(null);
  const [roles, setRoles] = useState<WorkspaceRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    // Roles only name the groups; without them the rules still read, by slug.
    void adapter.rest.listRoles(state.workspace.id).then((list) => setRoles(list.items)).catch(() => setRoles([]));
    return adapter.rest.listApprovalRoutes(state.workspace.id)
      .then((list) => setRoutes(list.items))
      .catch(() => setError('Could not load who approves what. Try again.'));
  }, [adapter, state.workspace.id]);
  useEffect(() => { void load(); }, [load]);

  const names = useMemo(() => roleNameMap(roles), [roles]);
  const replace = (next: ApprovalRoute) => setRoutes((rows) => rows?.map((row) => row.key === next.key ? next : row) ?? rows);

  if (error) return <div role="alert" className="admin-roles-error"><p>{error}</p><Button onClick={() => void load()}>Try again</Button></div>;
  if (!routes) return <Skeleton rows={4} label="Loading approvals" />;
  if (routeKey) {
    const selected = routes.find((route) => route.key === routeKey);
    if (!selected) return <EmptyState icon="admission" title="Approval not found" action={<Button onClick={() => nav(ADMIN(ADMIN_APPROVALS_VIEW))}>All approvals</Button>} />;
    return <ApprovalRouteDetail key={selected.key} route={selected} roles={roles} onSaved={replace} />;
  }
  const { decisions, actions } = splitRoutes(routes);
  const group = (title: string, description: string, rows: ApprovalRoute[]) => <section className="admin-approvals-group" aria-label={title}>
    <header><h3>{title}</h3><p>{description}</p></header>
    <ul className="admin-roles-list" aria-label={title}>
      {rows.map((route) => <li key={route.key}>
        <button type="button" className="admin-roles-row" onClick={() => nav({ ...ADMIN(ADMIN_APPROVALS_VIEW), id: route.key })}>
          <span className="admin-roles-name">{route.label}</span>
          <span className="admin-roles-description">{route.description}</span>
          <span className="admin-approvals-rule">
            {ruleSummary(route, names)}
            {route.is_default && <span className="admin-approvals-default"> · Default</span>}
          </span>
          {route.workflow_note && <span className="admin-roles-description">{route.workflow_note}</span>}
        </button>
      </li>)}
    </ul>
  </section>;
  return <>
    <header className="admin-detail-heading"><div>
      <h2>Approvals</h2>
      <p>{APPROVALS_SCOPE}</p>
      <p>{APPROVALS_LIVE}</p>
    </div></header>
    {group('Decisions', 'Closing a request an agent prepared. One person decides unless you ask for more.', decisions)}
    {group('Actions after approval', 'What happens once a request is approved. These can need more than one person.', actions)}
  </>;
}

function ApprovalRouteDetail({ route, roles, onSaved }: { route: ApprovalRoute; roles: WorkspaceRole[]; onSaved: (route: ApprovalRoute) => void }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const lists = useWorkspaceLists();
  const admins = useMemo(
    () => lists.members.filter((member) => member.role === 'admin' && member.status === 'active').map((member) => member.name).sort((a, b) => a.localeCompare(b)),
    [lists.members],
  );
  const sorted = useMemo(() => sortRoles(roles), [roles]);
  const [rule, setRule] = useState<ApprovalRouteRule>(route.rule);
  // The band above an amount. The amount stays the raw text typed, so "5000."
  // mid-edit is not rewritten under the cursor; it becomes minor units on save.
  const [bandOn, setBandOn] = useState(route.threshold !== null);
  const [amount, setAmount] = useState(route.threshold ? minorToAmount(route.threshold.over_minor) : '');
  const [currency, setCurrency] = useState(route.threshold?.currency ?? 'USD');
  const [bandRule, setBandRule] = useState<ApprovalRouteRule>(route.threshold?.rule ?? route.rule);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'reset'>('idle');
  const [problem, setProblem] = useState<unknown>(null);

  const overMinor = amountToMinor(amount);
  const threshold: ApprovalThreshold | null = bandOn && overMinor !== null && validCurrency(currency)
    ? { over_minor: overMinor, currency, rule: bandRule }
    : null;
  const bandProblem = !bandOn ? null
    : overMinor === null ? AMOUNT_PROBLEM
      : !validCurrency(currency) ? CURRENCY_PROBLEM
        : !bandRule.admins && bandRule.roles.length === 0 ? NO_APPROVER_MESSAGE
          : null;
  const nobody = !rule.admins && rule.roles.length === 0;
  const invalid = nobody || bandProblem !== null;
  const changed = (bandOn && threshold === null) || !sameRouteRules({ rule, threshold }, { rule: route.rule, threshold: route.threshold });
  const busy = saveState === 'saving';
  const touch = () => {
    setSaveState('idle');
    setProblem(null);
  };
  const edit = (next: Partial<ApprovalRouteRule>) => {
    touch();
    setRule((current) => settleRule({ ...current, ...next }));
  };
  const editBand = (next: Partial<ApprovalRouteRule>) => {
    touch();
    setBandRule((current) => settleRule({ ...current, ...next }));
  };
  const finish = (next: ApprovalRoute, done: 'saved' | 'reset') => {
    onSaved(next);
    setRule(next.rule);
    setBandOn(next.threshold !== null);
    setAmount(next.threshold ? minorToAmount(next.threshold.over_minor) : '');
    setCurrency(next.threshold?.currency ?? 'USD');
    setBandRule(next.threshold?.rule ?? next.rule);
    setSaveState(done);
  };
  const fail = (error: unknown) => {
    // The draft stays as typed, so a sign-in or a retry does not lose it.
    setProblem(error);
    setSaveState('idle');
  };
  const save = () => {
    setSaveState('saving');
    setProblem(null);
    const body = { ...rule, roles: [...rule.roles], threshold: threshold ? { ...threshold, rule: { ...threshold.rule, roles: [...threshold.rule.roles] } } : null };
    void adapter.rest.updateApprovalRoute(state.workspace.id, route.key as ApprovalRouteKey, body)
      .then((next) => finish(next, 'saved'))
      .catch(fail);
  };
  const reset = () => {
    setSaveState('saving');
    setProblem(null);
    void adapter.rest.resetApprovalRoute(state.workspace.id, route.key as ApprovalRouteKey)
      .then((next) => finish(next, 'reset'))
      .catch(fail);
  };
  const status = saveState === 'saved' && !changed ? 'Saved.' : saveState === 'reset' && !changed ? 'Back to the default.' : '';
  const alert = nobody ? NO_APPROVER_MESSAGE : bandProblem;

  // One Save for the page, in the last card, because the base rule and the
  // band above an amount are saved together.
  const footer = <>
    {problem !== null
      ? <Problem error={problem} />
      : alert
        ? <p role="alert">{alert}</p>
        : <p role="status">{status || (route.is_default && !changed ? 'This is the default.' : '')}</p>}
    <div className="admin-roles-actions">
      {!route.is_default && <Button disabled={busy} onClick={reset}>Reset to default</Button>}
      <Button primary disabled={!changed || invalid || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
    </div>
  </>;
  const controls = { route, roles, sorted, admins, busy };

  return <>
    <div><Button link onClick={() => nav(ADMIN(ADMIN_APPROVALS_VIEW))}>← Approvals</Button></div>
    <header className="admin-detail-heading"><div>
      <h2>{route.label}</h2>
      <p>{route.description}</p>
      {route.workflow_note && <p>{route.workflow_note}</p>}
      <p>{APPROVALS_LIVE}</p>
    </div></header>

    <AdminSettingsCard
      title="Who can approve"
      description={route.kind === 'decision' ? 'Anyone in a checked group can make this decision.' : 'Anyone in a checked group can do this.'}
      footer={route.amount ? undefined : footer}
    >
      <RuleControls {...controls} rule={rule} onEdit={edit} legend={`Groups who can approve ${route.label}`} />
    </AdminSettingsCard>

    {route.amount && <AdminSettingsCard
      title="Above an amount"
      description="Larger invoices can need different people. This uses the invoice total."
      footer={footer}
    >
      <div className="kv">
        <span className="grow">Use a different rule above an amount</span>
        <Toggle
          checked={bandOn}
          disabled={busy}
          label="Use a different rule above an amount"
          onChange={(value) => {
            touch();
            setBandOn(value);
          }}
        />
      </div>
      {bandOn && <>
        <div className="admin-approvals-amount">
          <label className="field">
            <span>Above</span>
            <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="5000" value={amount} disabled={busy} aria-invalid={overMinor === null}
              onChange={(event) => { touch(); setAmount(event.target.value); }} />
          </label>
          <label className="field admin-approvals-currency">
            <span>Currency</span>
            <input type="text" maxLength={3} autoCapitalize="characters" spellCheck={false} value={currency} disabled={busy} aria-invalid={!validCurrency(currency)}
              onChange={(event) => { touch(); setCurrency(event.target.value.toUpperCase().replace(/[^A-Z]/g, '')); }} />
          </label>
        </div>
        <p className="meta">{OTHER_CURRENCY_HINT}</p>
        <RuleControls {...controls} rule={bandRule} onEdit={editBand} legend={`Groups who can approve ${route.label} above the amount`} />
      </>}
    </AdminSettingsCard>}
  </>;
}

/** Who, how many, one from each group, and the requester question, for one band of a rule. */
function RuleControls({ route, roles, sorted, admins, busy, rule, onEdit, legend }: {
  route: ApprovalRoute;
  roles: WorkspaceRole[];
  sorted: WorkspaceRole[];
  admins: string[];
  busy: boolean;
  rule: ApprovalRouteRule;
  onEdit: (next: Partial<ApprovalRouteRule>) => void;
  legend: string;
}) {
  const warnings = unheldRoles(rule, roles);
  return <>
    <fieldset className="admin-roles-people">
      <legend className="sr-only">{legend}</legend>
      <label className="admin-roles-person">
        <input type="checkbox" disabled={busy} checked={rule.admins} onChange={(event) => onEdit({ admins: event.target.checked })} />
        <span className="admin-approvals-choice">Admins{' '}<span className="admin-roles-person-note">{admins.length ? admins.join(', ') : 'No Admins yet'}</span></span>
      </label>
      {sorted.map((role) => <label key={role.id} className="admin-roles-person">
        <input
          type="checkbox"
          disabled={busy}
          checked={rule.roles.includes(role.slug)}
          onChange={(event) => {
            // Kept in the page's role order, so the summary reads the same whatever order they were ticked in.
            const next = event.target.checked ? [...rule.roles, role.slug] : rule.roles.filter((slug) => slug !== role.slug);
            const rank = (slug: string) => { const index = sorted.findIndex((row) => row.slug === slug); return index < 0 ? sorted.length : index; };
            onEdit({ roles: [...next].sort((a, b) => rank(a) - rank(b)) });
          }}
        />
        <span className="admin-approvals-choice">{role.name}{' '}<span className="admin-roles-person-note">{roleHolders(role)}</span></span>
      </label>)}
    </fieldset>
    {warnings.map((name) => <p key={name} className="admin-approvals-warning">{unheldWarning(name)}</p>)}
    <label className="kv">
      <span className="grow">How many different people</span>
      <select
        className="admin-approvals-count"
        disabled={busy}
        value={rule.approvals_required}
        onChange={(event) => onEdit({ approvals_required: Number(event.target.value) })}
      >
        {Array.from({ length: MAX_APPROVALS }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
      </select>
    </label>
    {canRequireEachGroup(rule) && <div className="kv">
      <span className="grow">One from each group</span>
      <Toggle checked={rule.one_from_each} disabled={busy} label="One from each group" onChange={(value) => onEdit({ one_from_each: value })} />
    </div>}
    <div className="kv">
      <span className="grow">{requesterQuestion(route.kind)}</span>
      <Toggle checked={rule.allow_requester} disabled={busy} label={requesterQuestion(route.kind)} onChange={(value) => onEdit({ allow_requester: value })} />
    </div>
  </>;
}
