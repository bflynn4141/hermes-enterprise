import { useCallback, useEffect, useRef, useState } from 'react';
import { ADMIN, type MemberEntity, type MemberWalletAccess as Access } from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Button, Dialog, Skeleton } from '../ui/primitives.js';
import { AdminSettingsCard } from './AdminDetailLayout.js';
import { signWorkspaceOperation, PasskeyError } from '../../model/passkey.js';
import { useStepUp } from './use-step-up.js';

export function memberWalletError(error: unknown): string {
  if (error instanceof PasskeyError) return error.reason === 'cancelled' ? 'Passkey confirmation cancelled. The request is still waiting for review.'
    : error.reason === 'unsupported' ? 'Use a browser that supports passkeys to confirm this request.' : 'The passkey could not confirm this request. Check its status before trying again.';
  const reason = (error as { reason?: string } | null)?.reason;
  if (reason === 'reauth_required') return 'Sign in again to continue.';
  if (reason?.includes('expired')) return 'This request expired. Create a new request.';
  if (reason?.includes('changed')) return 'The member or wallet owner changed. Review a new request.';
  return 'The change could not be confirmed. Check status before trying again.';
}

export function MemberWalletAccess({ member, compact = false }: { member: MemberEntity; compact?: boolean }) {
  const state = useAppState();
  return <WalletAccessContent key={`${state.workspace.id}:${state.user.id}:${member.id}`} member={member} compact={compact} />;
}

function WalletAccessContent({ member, compact }: { member: MemberEntity; compact: boolean }) {
  const state = useAppState(), adapter = useAdapter(), nav = useNav();
  const [access, setAccess] = useState<Access | null>(null), [error, setError] = useState<unknown>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [review, setReview] = useState(false);
  const alive = useRef(true), flight = useRef(false), revision = useRef(0);
  const { needsSignIn, signIn } = useStepUp('wallet_setup');
  useEffect(() => { alive.current = true; return () => { alive.current = false; revision.current++; }; }, []);
  const load = useCallback(async () => {
    const version = ++revision.current;
    try { const value = await adapter.rest.memberWalletAccess(state.workspace.id, member.id); if (alive.current && revision.current === version) { setAccess(value); setError(null); setUnconfirmed(false); } }
    catch (caught) { if (alive.current && revision.current === version) setError(caught); }
  }, [adapter, state.workspace.id, member.id]);
  useEffect(() => { void load(); }, [load, member.status]);
  const act = async (request: () => Promise<Access>) => {
    if (flight.current) return;
    flight.current = true; revision.current++; setBusy(true); setError(null);
    try { const value = await request(); if (alive.current) { setAccess(value); setUnconfirmed(false); setReview(false); adapter.invalidateList('history'); } }
    catch (caught) {
      if (alive.current) {
        // A lost response must never encourage another provider write. The
        // server's durable operation decides whether signing is still allowed.
        try { const value = await adapter.rest.memberWalletAccess(state.workspace.id, member.id); if (alive.current) { setAccess(value); setUnconfirmed(false); } }
        catch { if (alive.current && !(caught instanceof PasskeyError)) setUnconfirmed(true); }
        if (alive.current) { setError(caught); setReview(false); }
      }
    } finally { flight.current = false; if (alive.current) setBusy(false); }
  };
  if (!access) return error ? <div role="alert">Wallet access could not be loaded. <Button onClick={() => void load()}>Try again</Button></div> : <Skeleton rows={3} label="Loading wallet access" />;
  const op = access.operation;
  const pending = op?.status === 'awaiting_owner_review';
  const checking = op?.status === 'submitting' || op?.status === 'outcome_unknown';
  const active = member.status === 'active';
  const action = unconfirmed ? <Button disabled={busy} onClick={() => void load()}>Check status</Button>
    : needsSignIn(error) ? <Button onClick={signIn}>Sign in again</Button>
    : checking && op ? <Button disabled={busy} onClick={() => void act(() => adapter.rest.reconcileMemberWallet(state.workspace.id, member.id, op.id))}>{busy ? 'Checking…' : 'Check status'}</Button>
    : pending && op ? <><Button disabled={busy || !access.can_manage} onClick={() => void act(() => adapter.rest.cancelMemberWallet(state.workspace.id, member.id, op.id))}>Cancel request</Button>{op.request && active && <Button primary disabled={busy} onClick={() => setReview(true)}>Review request</Button>}</>
    : access.wallet_status !== 'ready' && active && access.can_manage && access.capability.available ? <Button primary disabled={busy} onClick={() => void act(() => adapter.rest.proposeMemberWallet(state.workspace.id, member.id, 'create_wallet'))}>{busy ? 'Preparing…' : 'Create wallet'}</Button>
    : access.can_manage && access.capability.reason === 'owner_setup_required' ? <Button onClick={() => nav(ADMIN('Wallets'))}>Set up wallet owner</Button> : undefined;
  const row = (label: string, value: string) => <div className="member-detail-row"><span className="meta">{label}</span><span>{value}</span></div>;
  return <>
    <AdminSettingsCard title={compact ? 'Wallet follow-up' : 'Wallet access'} footer={action}>
      {row('Wallet', access.wallet_status === 'ready' ? 'Ready' : pending ? 'Awaiting owner review' : 'Not created')}
      {access.address && <div className="member-detail-row"><span className="meta">Address</span><code className="member-wallet-address">{access.address}</code></div>}
      {row('Can review payments', access.payment_review.allowed === null ? 'Not verified' : access.payment_review.allowed ? 'Yes · Last confirmed' : 'No · Last confirmed')}
      {op && (pending || checking) && row('Pending change', op.summary)}
      {pending && !op?.request && <p className="meta">{access.owner?.name ?? 'The wallet owner'} needs to review this request.</p>}
      {(checking || unconfirmed) && <p role="status" className="meta">We’re checking whether this change finished.</p>}
      {op?.status === 'expired' && <p role="status" className="meta">The request expired. Nothing was submitted.</p>}
      {op?.status === 'changed' && <p role="status" className="meta">Member or owner details changed. A new review is needed.</p>}
      {op?.status === 'rejected' && <p role="status" className="meta">The wallet request was rejected.</p>}
      {!active && <p className="meta">Workspace access is removed. This record does not confirm removal of wallet permissions.</p>}
      {!compact && <details className="member-wallet-explanation"><summary>About payment access</summary><p className="meta">A wallet address does not grant payment authority. Payment review will become available after member authentication and owner-approved permissions are verified.</p></details>}
      {!access.capability.available && access.capability.reason !== 'owner_setup_required' && <p className="meta">Wallet creation is not enabled for this workspace.</p>}
      {error !== null && <p role="alert" className="action-error">{memberWalletError(error)}</p>}
    </AdminSettingsCard>
    <Dialog open={review && Boolean(op?.request) && pending} title={`Create a wallet for ${member.name}?`} onClose={() => { if (!busy) setReview(false); }} actions={<><Button disabled={busy} onClick={() => setReview(false)}>Cancel</Button><Button primary disabled={busy || !op?.request} onClick={() => {
      if (!op?.request) return;
      const proposal = op;
      void act(async () => {
        const stamp = await signWorkspaceOperation(proposal.request!);
        return adapter.rest.submitMemberWallet(state.workspace.id, member.id, proposal.id, proposal.proposal_hash, stamp);
      });
    }}>{busy ? 'Confirming…' : 'Confirm with passkey'}</Button></>}>
      {row('Workspace', state.workspace.name)}{row('Member', member.name)}{row('Wallet owner', access.owner?.name ?? 'Unknown')}{row('Network', 'Base · USDC')}
      <p className="meta">Your owner passkey approves this wallet at Turnkey. Payment permissions stay separate.</p>
      {op && <p className="meta">Request expires {new Date(op.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>}
    </Dialog>
  </>;
}
