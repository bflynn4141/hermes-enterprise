// Refreshing an OAuth token whose provider rotates the refresh token.
//
// Slack (token rotation), Microsoft and Nous Portal answer a refresh with a new
// refresh token, and the old one stops working (at once, or after a short grace
// period). From that moment the provider's response is the only copy of a
// working credential. If it is written in the caller's transaction, anything
// that rolls that transaction back later (a failed query, a failed commit, a
// crash while the caller does other work) loses it, and the connection stays
// broken until someone reconnects it.
//
// So a refresh never shares the caller's transaction. It runs in its own short
// transaction on its own connection, which:
//
//   1. locks the credential row, so two requests cannot both spend the same
//      refresh token (the second waits, then finds the token already fresh);
//   2. calls the provider;
//   3. seals and writes the answer, and commits, before the caller continues.
//
// If that write or commit fails after the provider answered, the rotated token
// is written again in a fresh transaction. A crash between the provider's answer
// and the commit can still lose it; that window is one UPDATE and a COMMIT,
// not the caller's whole transaction.
import type { Tx } from '../db/client.js';

/**
 * Runs `fn` in a new tenant-scoped transaction on its own connection and
 * commits it before returning. The caller supplies it, because only the caller
 * knows the workspace and the database role its work runs under.
 */
export type OwnTransaction = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * Bounds the wait for the credential row lock. Another refresh holds it for at
 * most one provider call; a caller that already held it itself would otherwise
 * wait on its own transaction forever.
 */
const LOCK_TIMEOUT = '30s';

/** Attempts to write a rotated token after the provider answered. */
const STORE_ATTEMPTS = 3;

export interface RotatingRefresh<C, R> {
  /**
   * Lock the credential row and open it. Throws if it is gone or no longer
   * usable. `FOR NO KEY UPDATE` excludes a second refresh but not a foreign-key
   * check, so a caller that inserted a row referencing this one does not block it.
   */
  lock(tx: Tx): Promise<C>;
  /** The result without refreshing, when the locked credential is still fresh (another request refreshed it). */
  reuse(current: C): R | null;
  /** Ask the provider for a new credential. */
  exchange(current: C): Promise<C>;
  /** Seal and write the new credential to the locked row. */
  store(tx: Tx, next: C): Promise<R>;
}

export async function refreshRotatingToken<C, R>(own: OwnTransaction, refresh: RotatingRefresh<C, R>): Promise<R> {
  const answered: { value?: C } = {};
  let failure: unknown;
  try {
    return await own(async (tx) => {
      await tx.query(`SELECT set_config('lock_timeout', $1, true)`, [LOCK_TIMEOUT]);
      const current = await refresh.lock(tx);
      const reused = refresh.reuse(current);
      if (reused !== null) return reused;
      answered.value = await refresh.exchange(current);
      return refresh.store(tx, answered.value);
    });
  } catch (error) {
    // Nothing came back from the provider: the stored token is still the valid one.
    if (!('value' in answered)) throw error;
    failure = error;
  }
  const value = answered.value as C;
  for (let attempt = 1; attempt < STORE_ATTEMPTS; attempt += 1) {
    try {
      return await own(async (tx) => {
        await tx.query(`SELECT set_config('lock_timeout', $1, true)`, [LOCK_TIMEOUT]);
        await refresh.lock(tx);
        return refresh.store(tx, value);
      });
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
