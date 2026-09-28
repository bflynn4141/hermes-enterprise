import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentDirectoryEntry, MemberEntity, WalletEnrollmentInput, WalletOverview } from '@hermes/shared';
import { useAdapter, useAppState } from '../store-context.js';
import { Button, EmptyState, Skeleton } from '../ui/primitives.js';
import './wallets.css';
import { useStepUp } from './use-step-up.js';
import { AdminPageHeader, AdminSettingsCard } from './AdminDetailLayout.js';

export function walletError(error: unknown): string {
  const reason = (error as { reason?: string } | null)?.reason;
  return reason === 'reauth_required' ? 'Requesting wallet setup needs a recent sign-in.'
    : reason === 'wallets_unavailable' ? 'Wallet setup is not enabled for this deployment.'
    : reason === 'admin_required' ? 'An admin needs to request wallet setup.'
    : 'Wallet setup could not be confirmed. Refresh the status before trying again.';
}

export function useWallets() {
  const adapter = useAdapter();
  const state = useAppState();
  const [data, setData] = useState<WalletOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const { needsSignIn, signIn } = useStepUp('wallet_setup');
  const inFlight = useRef(false);
  const revision = useRef(0);
  const scope = `${state.workspace.id}:${state.user.id}`;
  const dataScope = useRef(scope);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const load = useCallback(async () => {
    const requestRevision = ++revision.current;
    setError(null);
    try {
      const next = await adapter.rest.wallets(state.workspace.id);
      if (latestScope.current === scope && requestRevision === revision.current) { dataScope.current = scope; setData(next); }
    } catch {
      if (latestScope.current === scope && requestRevision === revision.current) setError('Wallet status could not be loaded. Try again.');
    }
  }, [adapter, state.workspace.id, scope]);
  useEffect(() => { setData(null); void load(); }, [load]);
  const request = async (input: WalletEnrollmentInput) => {
    if (inFlight.current) return;
    inFlight.current = true;
    revision.current++;
    setReauth(false);
    setBusy(true);
    setError(null);
    try {
      const record = await adapter.rest.requestWalletEnrollment(state.workspace.id, input);
      if (latestScope.current !== scope) return;
      setData(current => current ? { ...current, setup_status: 'awaiting_owner_enrollment', items: [...current.items.filter(item => item.id !== record.id), record] } : current);
    } catch (caught) {
      if (latestScope.current === scope) { setError(walletError(caught)); setReauth(needsSignIn(caught)); }
    } finally { inFlight.current = false; setBusy(false); }
  };
  return { data: dataScope.current === scope ? data : null, error, busy, request, load, reauth, signIn };
}

export function AdminWallets() {
  const wallets = useWallets();
  const adapter = useAdapter();
  const state = useAppState();
  const [agents, setAgents] = useState<AgentDirectoryEntry[]>([]);
  const [agentError, setAgentError] = useState(false);
  useEffect(() => {
    if (!wallets.data?.enabled || !wallets.data.can_manage) { setAgents([]); return; }
    let live = true;
    setAgentError(false);
    void adapter.rest.adminAgents(state.workspace.id).then(result => { if (live) setAgents(result.items); }).catch(() => { if (live) setAgentError(true); });
    return () => { live = false; };
  }, [adapter, state.workspace.id, wallets.data?.enabled, wallets.data?.can_manage]);
  const { data, error, busy, request, load } = wallets;
  const requested = data?.items.some(item => item.kind === 'workspace');
  return <div className="admin-detail-page">
    <AdminPageHeader title="Wallets" />
    <AdminSettingsCard title="Workspace wallets" description="Separate workspace, member and agent wallets, with customer-controlled ownership."
      footer={wallets.reauth ? <Button onClick={wallets.signIn}>Sign in again</Button> : error ? <Button disabled={busy} onClick={() => void load()}>Refresh status</Button> : data?.enabled && data.can_manage && !requested ?
        <Button disabled={busy} onClick={() => void request({ kind: 'workspace' })}>{busy ? 'Requesting setup…' : 'Request wallet setup'}</Button> : undefined}>
      {!data && !error ? <Skeleton rows={2} label="Loading wallet status" /> : <>
        <p role="status">{!data ? 'Status unavailable' : !data.enabled ? 'Wallet setup is not enabled for this deployment.' : requested ? 'Setup requested · Needs owner setup' : 'Not set up'}</p>
        {data?.enabled && <><div className="kv"><span className="grow">Network and asset</span><span>Base mainnet · USDC</span></div>
          <p className="meta">{requested ? 'Your request is saved. Owner enrollment and provider verification are still required before addresses are available.' : 'Requesting setup saves an enrollment request. Owner enrollment and provider verification come next.'}</p>
          <p className="meta">Payments and signing are not enabled.</p>
        </>}
      </>}
      {error && <p role="alert">{error}</p>}
    </AdminSettingsCard>
    {data?.enabled && data.can_manage && <AdminSettingsCard title="Agent wallets" description="Request a separate wallet for each agent; owner enrollment is required before an address is available.">
      {agentError ? <p role="alert">Agents could not be loaded. Reopen this page to try again.</p> : agents.length === 0 ? <EmptyState icon="people" title="No agents available" /> : agents.map(agent => {
        const record = data.items.find(item => item.kind === 'agent' && item.agent_id === agent.id);
        return <div className="wallet-agent-row" key={agent.id}>
          <div><strong>{agent.name}</strong>{agent.owner ? <p className="meta">Owner · {agent.owner.name}</p> : <p className="meta">Assign an owner before requesting a wallet.</p>}<p className="meta">{record ? 'Needs owner setup' : 'Not set up'}</p></div>
          {!record && agent.owner && <Button disabled={busy || Boolean(error)} onClick={() => void request({ kind: 'agent', agent_id: agent.id })}>Request wallet setup for {agent.name}</Button>}
        </div>;
      })}
    </AdminSettingsCard>}
  </div>;
}

export function MemberWallet({ member, wallets }: { member: MemberEntity; wallets: ReturnType<typeof useWallets> }) {
  const state = useAppState();
  const { data, busy, error, request } = wallets;
  if (!data?.enabled || (!data.can_manage && member.user_id !== state.user.id)) return null;
  const record = data.items.find(item => item.kind === 'member' && item.member_id === member.id);
  return <div aria-label={`${member.name} wallet`}>
    <p className="meta">Wallet · {record ? 'Needs owner setup' : 'Not set up'}</p>
    {!record && data.can_manage && member.status === 'active' && <Button disabled={busy || Boolean(error)} onClick={() => void request({ kind: 'member', member_id: member.id })}>Request wallet setup for {member.name}</Button>}
    {error && <p role="alert">{error} {wallets.reauth ? <Button onClick={wallets.signIn}>Sign in again</Button> : <Button disabled={busy} onClick={() => void wallets.load()}>Refresh status</Button>}</p>}
  </div>;
}
