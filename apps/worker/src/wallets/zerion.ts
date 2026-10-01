// Wallet balances from Zerion (C103), the default source while Turnkey's
// balances API needs a paid plan. Zerion is read-only and keyless for the
// wallet: it is sent a public address and returns its Base token positions
// with USD values. Responses are cached per address for a minute so a busy
// Balances page stays inside the free plan (2,000 requests a day, 3 a second).
import type { Env } from '../env.js';
import type { TurnkeyAssetBalance } from './turnkey-client.js';

const ZERION_BASE = 'https://api.zerion.io';
const CACHE_SECONDS = 60;

export class ZerionError extends Error {
  constructor(readonly status: number | null) {
    super(`Zerion request failed (${status ?? 'network'})`);
  }
}

export function zerionFetcher(env: Env): typeof fetch {
  if (!env.ZERION_FETCHER) return (input, init) => globalThis.fetch(input, { ...init, redirect: 'manual' });
  return (input, init) => env.ZERION_FETCHER!.fetch(new Request(input, init));
}

type Position = {
  attributes?: {
    quantity?: { int?: unknown; decimals?: unknown };
    value?: unknown;
    fungible_info?: { symbol?: unknown; name?: unknown };
  };
  relationships?: { chain?: { data?: { id?: unknown } } };
};

/** Base token positions for one address, in the same shape as Turnkey's reader. */
export async function readZerionBaseBalances(apiKey: string, address: string, fetcher: typeof fetch = fetch): Promise<TurnkeyAssetBalance[]> {
  const url = new URL(`/v1/wallets/${encodeURIComponent(address)}/positions/`, ZERION_BASE);
  url.searchParams.set('filter[chain_ids]', 'base');
  url.searchParams.set('filter[positions]', 'only_simple');
  url.searchParams.set('filter[trash]', 'only_non_trash');
  url.searchParams.set('currency', 'usd');
  const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default?: Cache }).default ?? null;
  // The cache key carries the address only; the API key never leaves the request headers.
  const cacheKey = new Request(`https://zerion-cache.hermes.invalid/${address.toLowerCase()}`);
  let response = cache ? await cache.match(cacheKey) : undefined;
  if (!response) {
    try {
      response = await fetcher(url.toString(), {
        headers: { accept: 'application/json', authorization: `Basic ${btoa(`${apiKey}:`)}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ZerionError(null);
    }
    if (!response.ok) throw new ZerionError(response.status);
    if (cache) {
      const copy = new Response(response.clone().body, { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SECONDS}` } });
      await cache.put(cacheKey, copy).catch(() => undefined);
    }
  }
  let body: { data?: Position[] };
  try { body = await response.json() as { data?: Position[] }; } catch { throw new ZerionError(response.status); }
  return (body.data ?? []).flatMap((position) => {
    const a = position.attributes;
    const amount = a?.quantity?.int, decimals = a?.quantity?.decimals, symbol = a?.fungible_info?.symbol;
    if (position.relationships?.chain?.data?.id !== 'base' || typeof symbol !== 'string' || !symbol
      || typeof amount !== 'string' || !/^\d+$/.test(amount) || amount === '0'
      || typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return [];
    const value = typeof a?.value === 'number' && Number.isFinite(a.value) && a.value >= 0 ? a.value.toFixed(6) : null;
    const name = typeof a?.fungible_info?.name === 'string' ? a.fungible_info.name : symbol;
    return [{ symbol: symbol.slice(0, 16), name: name.slice(0, 64), decimals, balance: amount, usd: value }];
  });
}
