// The model menu.
//
// It used to be eight lines inside the composer, because the catalog was four
// rows. With Nous Portal a workspace's catalog is several hundred, and that
// changes what the menu *is*: not a list to read but a thing to search.
//
// What the shape has to earn, in order:
//
//   Search first.       A person looking for Sonnet types "sonn"; a person
//                       browsing scrolls. Both work, and the query goes to the
//                       server (`?q=`) rather than filtering a list we already
//                       downloaded, because the list we already downloaded is
//                       one page of it.
//   Grouped by vendor.  `anthropic/`, `openai/`, `google/`, `meta-llama/`. The
//                       segment before the slash is the only grouping Nous Portal
//                       gives us and it is the one people already think in.
//   Paged, not scrolled forever. 60 rows, then "Show more". Virtualising would
//                       be faster and is not free: it breaks find-in-page, it
//                       breaks the roving focus below, and 60 rows render in
//                       under a frame. If a workspace ever wants 3,000 rows in
//                       one group this is the line to revisit.
//   Priced.             Input/output per million and the context window, from
//                       the catalog row. Labelled "est." because the provider
//                       does the billing and `pricing_verified_on` is a date.
//   Honest about tools. The run engine calls a tool on every step, so a model
//                       without tool calling is shown greyed with the reason
//                       rather than omitted. The server agrees: such a row
//                       arrives with `enabled: false`.
//
// Keyboard: ArrowUp/ArrowDown move through the options (roving `tabindex`),
// Home/End jump, Enter picks, typing goes to the search box wherever focus is.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ADMIN, vendorPrefix, type CatalogEntry } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useNav } from '../store-context.js';
import { Icon } from '../ui/icons.js';
import { MenuItem, Popover } from '../ui/primitives.js';
import { EMPTY } from '../../model/constants.js';
import { catalogRows } from '../selectors.js';
import type { SessionState } from '../../model/store.js';

/** One page. Big enough to browse, small enough to render in a frame. */
export const MODEL_PAGE = 60;

/** USD per million, as a person reads it. */
export function priceLabel(entry: Pick<CatalogEntry, 'pricing_per_million'>): string {
  const money = (value: number): string =>
    value === 0 ? 'free' : value < 1 ? `$${value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}` : `$${value.toFixed(2)}`;
  return `${money(entry.pricing_per_million.input)} in · ${money(entry.pricing_per_million.output)} out /M est.`;
}

/** 200000 -> "200K", 1000000 -> "1M". A context window, not a number. */
export function contextLabel(length: number | null): string | null {
  if (length === null) return null;
  if (length >= 1_000_000) return `${Math.round(length / 100_000) / 10}M ctx`;
  if (length >= 1_000) return `${Math.round(length / 1_000)}K ctx`;
  return `${length} ctx`;
}

/**
 * Nous Portal exposes the free StepFun route as a distinct model id. Keep that
 * distinction visible anywhere two otherwise-identical labels can be picked.
 * Non-free Portal ids consume the workspace's paid Portal capacity.
 */
export function modelRouteLabel(row: { readonly model_id: string; readonly provider: string }): 'Free route' | 'Paid route' | null {
  if (row.provider !== 'nous_portal') return null;
  return row.model_id.endsWith(':free') ? 'Free route' : 'Paid route';
}

export interface ModelGroup {
  readonly vendor: string;
  readonly rows: CatalogEntry[];
}

/**
 * Group rows by vendor prefix, keeping the server's ordering inside a group and
 * putting the four seeded rows first under one heading.
 *
 * A pure function, and exported, because this is the part worth a unit test:
 * the grouping is what a person navigates by, and getting it wrong is silent.
 */
export function groupByVendor(rows: readonly CatalogEntry[]): ModelGroup[] {
  const groups = new Map<string, CatalogEntry[]>();
  for (const row of rows) {
    const vendor = vendorPrefix(row.model_id);
    const key = vendor === 'native' ? 'Direct' : vendor;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] === 'Direct' ? -1 : b[0] === 'Direct' ? 1 : a[0].localeCompare(b[0])))
    .map(([vendor, rowsInGroup]) => ({ vendor, rows: rowsInGroup }));
}

interface ModelMenuProps {
  readonly session: SessionState;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
}

export function ModelMenu({ session, open, onClose, anchorRef }: ModelMenuProps) {
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const nav = useNav();

  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<CatalogEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const companyDefault = (state.settings as { default_model_id?: string }).default_model_id ?? null;
  // Bootstrap's trimmed rows are what renders before the first page arrives, so
  // the menu never opens empty on a slow connection.
  const fallback = catalogRows(state);
  const selected = session.model;

  /**
   * One page, from the server.
   *
   * Debounced, and the response is discarded if another query started while it
   * was in flight: typing "sonnet" fires several requests and the last one
   * typed must win, not the last one to arrive.
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      adapter.rest
        .catalog(state.workspace.id, { q: query, limit: MODEL_PAGE })
        .then((page) => {
          if (cancelled) return;
          setRows(page.models);
          setCursor(page.next_cursor);
          setTotal(page.total);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, query === '' ? 0 : 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, state.workspace.id, adapter]);

  const showMore = (): void => {
    if (cursor === null || loading) return;
    setLoading(true);
    adapter.rest
      .catalog(state.workspace.id, { q: query, limit: MODEL_PAGE, after: cursor })
      .then((page) => {
        setRows((current) => [...(current ?? []), ...page.models]);
        setCursor(page.next_cursor);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  };

  const visible = rows ?? fallbackRows(fallback);
  const groups = useMemo(() => groupByVendor(visible), [visible]);
  const current = visible.find((row) => row.model_id === selected) ?? null;

  const pick = (row: CatalogEntry): void => {
    if (!row.enabled) return;
    const effort = row.supports_reasoning
      ? (row.effort_map && session.effort && row.effort_map[session.effort] ? session.effort : row.default_effort)
      : null;
    // The composer's own label reads `state.entities.catalog`, which is
    // seeded from bootstrap — and bootstrap deliberately carries only the
    // seeded rows plus the ones this workspace's sessions already name. A row
    // picked out of the paged list is not in there yet, so it goes in here;
    // otherwise the button under the menu would keep showing the old model
    // until the next page load, which reads as the pick not having worked.
    dispatch({
      type: 'entity/upsert',
      kind: 'catalog',
      id: row.model_id,
      version: 1,
      data: {
        model_id: row.model_id,
        label: row.label,
        provider: row.provider,
        effort: row.effort_map === null ? null : Object.keys(row.effort_map),
        default_effort: row.default_effort,
        enabled: row.enabled,
        disabled_reason: row.disabled_reason,
      },
    });
    void adapter.updateSessionSettings(session.id, { model_id: row.model_id, effort }).catch(() => undefined);
  };

  /**
   * Roving focus over the options.
   *
   * The options are ordinary buttons, so Tab would walk all sixty. Arrow keys
   * move focus instead and the search box keeps it by default, which is the
   * behaviour of every other combobox a person has used this week.
   */
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const options = [...(list.current?.querySelectorAll<HTMLButtonElement>('button.menu-item') ?? [])];
    if (options.length === 0) return;
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number): void => {
      event.preventDefault();
      options[Math.max(0, Math.min(options.length - 1, next))]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index <= 0 ? 0 : index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(options.length - 1);
  };

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={470} label="Model" above>
      <div className="row">
        <span className="p-title">Model</span>
        <span className="grow" />
        <span className="p-meta">This session · Next turn</span>
      </div>

      <div className="search">
        <Icon name="search" />
        <input
          placeholder="Search models…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search models"
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="col model-list" ref={list} onKeyDown={onKeyDown} style={{ gap: 2, maxHeight: 320, overflowY: 'auto' }}>
        {failed && <div className="p-meta model-note">Could not load the model list. It will retry when you reopen this.</div>}
        {!failed && visible.length === 0 && (
          <div className="p-meta model-note">{query === '' ? EMPTY.noProvider : `No model matches “${query}”.`}</div>
        )}
        {groups.map((group) => (
          <div key={group.vendor} className="model-group">
            <div className="model-group-head" role="presentation">
              {group.vendor}
            </div>
            {group.rows.map((row) => (
              <MenuItem
                key={row.model_id}
                checked={selected === row.model_id}
                disabled={!row.enabled}
                title={row.enabled ? row.model_id : row.disabled_reason ?? undefined}
                sub={subtitle(row)}
                right={
                  <span className="model-tags">
                    {modelRouteLabel(row) && <span className="model-route">{modelRouteLabel(row)}</span>}
                    {row.model_id === companyDefault && (
                      <span className="model-pin" title="The workspace default, set in Settings">
                        Company default
                      </span>
                    )}
                  </span>
                }
                onClick={() => pick(row)}
              >
                {row.label}
              </MenuItem>
            ))}
          </div>
        ))}
        {cursor !== null && (
          <button type="button" className="menu-item small" onClick={showMore} disabled={loading}>
            <span className="mi-body">
              <span>{loading ? 'Loading…' : 'Show more'}</span>
              <span className="mi-sub">
                {visible.length} of {total}
              </span>
            </span>
          </button>
        )}
      </div>

      <div className="divider" />
      <div className="row">
        <span>Effort</span>
        <span className="grow" />
        <span className="p-meta">
          {current?.supports_reasoning ? session.effort ?? current.default_effort ?? '—' : 'Not available for this model'}
        </span>
      </div>
      {current?.supports_reasoning && current.effort_map && (
        <div className="effort-row" role="radiogroup" aria-label="Effort">
          {Object.keys(current.effort_map).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={session.effort === value}
              onClick={() => {
                dispatch({ type: 'session/set', id: session.id, patch: { effort: value } });
                void adapter.rest.patchSession(state.workspace.id, session.id, { effort: value }).catch(() => undefined);
              }}
            >
              {value}
            </button>
          ))}
        </div>
      )}

      <div className="divider" />
      {state.user.role === 'admin' ? <MenuItem
        small
        onClick={() => {
          onClose();
          nav(ADMIN('Provider keys'));
        }}
        right={<Icon name="arrow" size={16} />}
      >
        Add or sync a model provider
      </MenuItem> : <p className="p-meta" style={{ padding: '0 12px' }}>A workspace Admin manages model providers.</p>}
    </Popover>
  );
}

/**
 * A bootstrap row has no price, and rendering one as "free" would be a lie a
 * person makes a decision on. This sentinel date marks a row whose price the
 * client has not been told yet; the real rows all carry a real one.
 */
const UNPRICED = '1970-01-01';

/** The line under a model's name: why not, or what it costs. */
function subtitle(row: CatalogEntry): string {
  if (!row.enabled) return row.disabled_reason ?? `No verified ${row.provider} key`;
  if (row.pricing_verified_on === UNPRICED) return `via ${row.provider}`;
  const context = contextLabel(row.context_length);
  return [priceLabel(row), context].filter(Boolean).join(' · ');
}

/**
 * Bootstrap's rows, widened to the shape the menu renders.
 *
 * Bootstrap carries a deliberately smaller row (id, label, provider, effort,
 * enabled) because it is trimmed to the seeded four plus whatever this
 * workspace's sessions name. It is what the menu shows for the instant before
 * the first page lands, and it is never what it shows afterwards.
 */
function fallbackRows(rows: ReturnType<typeof catalogRows>): CatalogEntry[] {
  return rows.map((row) => ({
    model_id: row.model_id,
    provider: row.provider as CatalogEntry['provider'],
    label: row.label,
    transport: 'deepseek_chat' as CatalogEntry['transport'],
    effort_map: row.effort === null ? null : Object.fromEntries(row.effort.map((value) => [value, value])),
    default_effort: row.default_effort,
    pricing_per_million: { input: 0, output: 0, input_off_peak: null, output_off_peak: null, cached_input: null },
    pricing_verified_on: UNPRICED,
    disabled_reason: row.disabled_reason,
    enabled: row.enabled,
    disabled_code: null,
    source: 'seed',
    context_length: null,
    supports_tools: true,
    supports_reasoning: row.effort !== null,
  }));
}
