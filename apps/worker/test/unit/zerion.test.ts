import { describe, expect, it } from 'vitest';
import { readZerionBaseBalances, setZerionRetryDelayForTests, ZerionError } from '../../src/wallets/zerion.js';

const position = (chain: string, symbol: string, int: string, decimals: number, value: number | null) => ({
  type: 'positions', id: `${symbol}-${chain}`,
  attributes: { quantity: { int, decimals, numeric: '', float: 0 }, value, price: 1, fungible_info: { symbol, name: `${symbol} token`, implementations: [] } },
  relationships: { chain: { data: { type: 'chains', id: chain } } },
});

describe('Zerion balance reads', () => {
  it('asks for simple, non-spam Base positions in USD with Basic auth', async () => {
    const seen: { url: URL; auth: string | null }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: new URL(String(input)), auth: new Headers(init?.headers).get('authorization') });
      return Response.json({ data: [position('base', 'USDC', '1500000', 6, 1.5)] });
    }) as typeof fetch;
    await readZerionBaseBalances('zk_test', '0xAbC0000000000000000000000000000000000001', fetcher);
    const { url, auth } = seen[0]!;
    expect(url.origin + url.pathname).toBe('https://api.zerion.io/v1/wallets/0xAbC0000000000000000000000000000000000001/positions/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ 'filter[chain_ids]': 'base', 'filter[positions]': 'only_simple', 'filter[trash]': 'only_non_trash', currency: 'usd' });
    expect(auth).toBe(`Basic ${btoa('zk_test:')}`);
  });

  it('keeps only Base tokens with a positive atomic amount, and never invents a price', async () => {
    const fetcher = (async () => Response.json({ data: [
      position('base', 'USDC', '1500000', 6, 1.5),
      position('ethereum', 'ETH', '1000000000000000000', 18, 2500),
      position('base', 'ETH', '500000000000000000', 18, null),
      position('base', 'ZERO', '0', 18, 0),
      position('base', 'BAD', '1.5', 18, 1),
    ] })) as typeof fetch;
    expect(await readZerionBaseBalances('k', '0x1', fetcher)).toEqual([
      { symbol: 'USDC', name: 'USDC token', decimals: 6, balance: '1500000', usd: '1.500000' },
      { symbol: 'ETH', name: 'ETH token', decimals: 18, balance: '500000000000000000', usd: null },
    ]);
  });

  it('throws on errors so the wallet shows Unavailable, not zero', async () => {
    await expect(readZerionBaseBalances('k', '0x1', (async () => new Response('', { status: 429 })) as typeof fetch)).rejects.toBeInstanceOf(ZerionError);
    await expect(readZerionBaseBalances('k', '0x1', (async () => { throw new TypeError('offline'); }) as typeof fetch)).rejects.toBeInstanceOf(ZerionError);
  });

  it('waits and retries when Zerion rate-limits, then gives up as unavailable', async () => {
    setZerionRetryDelayForTests(1);
    let calls = 0;
    const flaky = (async () => { calls++; return calls < 3 ? new Response('', { status: 429 }) : Response.json({ data: [position('base', 'USDC', '1000000', 6, 1)] }); }) as typeof fetch;
    expect(await readZerionBaseBalances('k', '0x1', flaky)).toHaveLength(1);
    expect(calls).toBe(3);
    calls = 0;
    const always = (async () => { calls++; return new Response('', { status: 429 }); }) as typeof fetch;
    await expect(readZerionBaseBalances('k', '0x1', always)).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(3);
  });
});
