// The same `useSyncExternalStore` shape the demo used, typed, plus the two
// hooks the entity cache needs: `useEntity`, which asks the adapter to fetch on
// a miss, and `useList`, which does the same for a paginated list.
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { Ref } from '@hermes/shared';
import type { Adapter } from '../model/adapter.js';
import { entity as selectEntity, list as selectList, type Action, type AppState, type EntityKind, type EntityRecord, type ListRecord, type Store } from '../model/store.js';

interface Ctx {
  store: Store;
  adapter: Adapter;
}

const Context = createContext<Ctx | null>(null);

export function StoreProvider({ store, adapter, children }: { store: Store; adapter: Adapter; children: ReactNode }) {
  return <Context.Provider value={{ store, adapter }}>{children}</Context.Provider>;
}

function useCtx(): Ctx {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('StoreProvider is missing');
  return ctx;
}

export const useStore = (): Store => useCtx().store;
export const useAdapter = (): Adapter => useCtx().adapter;

export function useAppState(): AppState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useDispatch(): (action: Action) => void {
  const store = useStore();
  return useCallback(
    (action: Action) => {
      store.dispatch(action);
    },
    [store],
  );
}

/** Chat blocks and app controls navigate through the same manual command. */
export function useNav(): (object: Ref) => void {
  const dispatch = useDispatch();
  return useCallback((object: Ref) => dispatch({ type: 'nav/app', object, manual: true }), [dispatch]);
}

export function useCurrentUser(): AppState['user'] {
  return useAppState().user;
}

export const useIsAdmin = (): boolean => useAppState().user.role === 'admin';

/**
 * Read one entity, fetching it if the cache does not have it. The record's
 * `state` is what a component keys its skeleton / empty copy off; it never
 * needs to know whether a fetch is in flight.
 */
export function useEntity<T>(kind: EntityKind, id: string | null | undefined): EntityRecord<T> {
  const state = useAppState();
  const adapter = useAdapter();
  const record = selectEntity<T>(state, kind, id);
  useEffect(() => {
    if (id && (!record || record.state === 'loading')) adapter.ensure(kind, id);
  }, [adapter, kind, id, record?.state]);
  return record ?? { data: null, version: 0, fetchedAt: 0, state: id ? 'loading' : 'missing' };
}

export function useList(key: string, load: () => Promise<Parameters<Adapter['ensureList']>[1] extends () => Promise<infer R> ? R : never>): ListRecord {
  const state = useAppState();
  const adapter = useAdapter();
  const record = selectList(state, key);
  useEffect(() => {
    adapter.ensureList(key, load);
    // `load` closes over the workspace id only; re-running on identity changes
    // would refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, key]);
  return record;
}
