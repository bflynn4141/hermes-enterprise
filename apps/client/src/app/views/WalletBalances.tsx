import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTokenAmount, type WalletAsset, type WalletBalanceAccount, type WalletBalances } from '@hermes/shared';
import { useAdapter, useAppState } from '../store-context.js';
import { Avatar, Button, Disclosure, EmptyState, IconButton, Item, Skeleton, Snippet, Toggle } from '../ui/primitives.js';
import { AdminSettingsCard } from './AdminDetailLayout.js';

/** Balances below this many dollars sit behind the "Small balances" switch, as in Splits. */
const SMALL_BALANCE_USD = 1;

const grouped = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const isSmall = (asset: WalletAsset) => asset.usd !== null && Number(asset.usd) < SMALL_BALANCE_USD;

/** "$1,234.56", from an exact two-decimal string. */
export function usdText(usd: string): string {
  const [whole, cents = '00'] = usd.split('.');
  return `$${grouped(whole!)}.${cents}`;
}

/** The headline figure: dollars large, cents small. */
function Total({ usd }: { usd: string }) {
  const [whole, cents = '00'] = usd.split('.');
  return <div className="wallet-total" role="img" aria-label={usdText(usd)}>
    <span className="wallet-total-dollars" aria-hidden="true">${grouped(whole!)}</span><span className="wallet-total-cents" aria-hidden="true">.{cents}</span>
  </div>;
}

export function useWalletBalances(active: boolean) {
  const adapter = useAdapter();
  const state = useAppState();
  const [data, setData] = useState<WalletBalances | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const load = useCallback(async () => {
    if (!active) return;
    const mine = ++revision.current;
    setLoading(true);
    setFailed(false);
    try {
      const next = await adapter.rest.walletBalances(state.workspace.id);
      if (mine === revision.current) setData(next);
    } catch {
      if (mine === revision.current) setFailed(true);
    } finally {
      if (mine === revision.current) setLoading(false);
    }
  }, [adapter, state.workspace.id, active]);
  useEffect(() => { setData(null); void load(); }, [load]);
  return { data, failed, loading, load };
}

function AssetRow({ asset }: { asset: WalletAsset }) {
  return <div className="wallet-asset">
    <span className="wallet-asset-name"><strong>{asset.symbol}</strong><span className="meta">{asset.name}</span></span>
    <span className="wallet-asset-value">
      <span>{asset.usd === null ? 'No price' : usdText(Number(asset.usd).toFixed(2))}</span>
      <span className="meta">{formatTokenAmount(asset.amount, asset.decimals)} {asset.symbol}</span>
    </span>
  </div>;
}

function AccountRow({ account, showSmall }: { account: WalletBalanceAccount; showSmall: boolean }) {
  const [open, setOpen] = useState(false);
  const assets = account.assets.filter((asset) => showSmall || !isSmall(asset));
  const hidden = account.assets.length - assets.length;
  const id = `wallet-assets-${account.principal_id}`;
  return <div className="wallet-account">
    <Item
      media={<Avatar person={{ name: account.label }} size={32} />}
      title={account.label}
      description={<Snippet value={account.address} display={shortAddress(account.address)} label={`${account.label}'s wallet address`} className="wallet-address" />}
      actions={<>
        <span className="wallet-account-balance">{account.status === 'ok' && account.usd !== null ? usdText(account.usd) : 'Unavailable'}</span>
        {account.status === 'ok' && account.assets.length > 0 && <IconButton name="chevron" className={open ? 'wallet-open' : ''} label={open ? `Hide ${account.label}'s tokens` : `Show ${account.label}'s tokens`}
          aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} />}
      </>}
    />
    <Disclosure open={open} id={id}>
      <div className="wallet-assets">
        {assets.map((asset) => <AssetRow key={asset.symbol} asset={asset} />)}
        {hidden > 0 && <p className="meta">{hidden === 1 ? '1 small balance hidden' : `${hidden} small balances hidden`}</p>}
      </div>
    </Disclosure>
  </div>;
}

/** Splits-style balances: one total, then every wallet with its address and balance. */
export function WalletBalancesCard({ active }: { active: boolean }) {
  const balances = useWalletBalances(active);
  const [showSmall, setShowSmall] = useState(false);
  if (!active) return null;
  const { data, failed, loading, load } = balances;
  const unavailable = data?.accounts.filter((a) => a.status === 'unavailable').length ?? 0;
  return <AdminSettingsCard title="Balances" description="Every wallet in this workspace, on Base."
    footer={<Button disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</Button>}>
    {!data && !failed ? <Skeleton rows={3} label="Loading balances" />
      : failed && !data ? <p role="alert">Balances could not be loaded. Try Refresh.</p>
      : data && !data.accounts.length ? <EmptyState compact icon="context" title="No wallets yet" detail="Create a member wallet from Members to see its balance here." />
      : data && <>
        {data.usd !== null ? <Total usd={data.usd} /> : <div className="wallet-total"><span className="wallet-total-dollars">Unavailable</span></div>}
        {unavailable > 0 && <p className="meta" role="status">{unavailable === 1 ? "1 wallet couldn't be read just now; the total leaves it out." : `${unavailable} wallets couldn't be read just now; the total leaves them out.`}</p>}
        <div className="wallet-small-toggle"><span className="meta">Small balances</span><Toggle checked={showSmall} onChange={setShowSmall} label="Show small balances" /></div>
        <div className="wallet-accounts">{data.accounts.map((account) => <AccountRow key={account.principal_id} account={account} showSmall={showSmall} />)}</div>
      </>}
    {failed && data && <p role="alert">Couldn't refresh; showing the last balances.</p>}
  </AdminSettingsCard>;
}
