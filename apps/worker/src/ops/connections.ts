// The connection alarm.
//
// Plan section 5: "A connection alarm at 150: two Hyperdrive configs of about
// 100 connections each against 209 on 0.5 CU; hubs add none."
//
// The arithmetic is the whole reason this exists. Two Hyperdrive configs, each
// of which will open up to roughly 100 origin connections, is up to 200 against
// a Neon 0.5 CU compute that accepts 209. There is no configuration that makes
// those two numbers safe together; what makes it safe is that neither config is
// ever near its ceiling in practice, and the thing that would tell us otherwise
// is this number. At 150 the next thing to happen is connection refusals that
// look, from a request's point of view, exactly like the database being down.
//
// It is a *health metric*, not a limiter. Nothing here refuses a request:
// refusing at 150 would take the product down to avoid taking it down. It logs,
// it goes on `/health` so a monitor can alert on it, and it writes a point to
// Analytics Engine where one exists.
import type { Env } from '../env.js';
import { connect } from '../db/client.js';
import { logEvent } from '../keys/redact.js';

/** Plan section 5. Crossing it is the alert, not the failure. */
export const CONNECTION_ALARM = 150;

/**
 * Neon's documented ceiling on 0.5 CU. Reported alongside the count so the
 * number on the health page carries its own denominator: "152" means nothing
 * and "152 of 209" means the afternoon is about to go badly.
 */
export const CONNECTION_CEILING = 209;

export interface ConnectionMetric {
  readonly total: number;
  readonly active: number;
  readonly idle: number;
  readonly idleInTransaction: number;
  readonly ceiling: number;
  readonly alarm: number;
  readonly alarming: boolean;
}

/**
 * Count backends on the origin.
 *
 * `pg_stat_activity` filtered to this database and excluding our own backend,
 * so the number does not move because we asked. It counts every connection,
 * including the ones a second Worker instance or a migration run opened — which
 * is correct: the ceiling is the server's, not ours, and a migration holding
 * connections during a deploy is exactly the case the alarm is for.
 *
 * `idle in transaction` is broken out because it is the shape of the specific
 * bug this system could have: a tenant transaction that opened, set its keys
 * and never committed pins a Hyperdrive connection for as long as it lives.
 */
export async function readConnectionMetric(env: Env): Promise<ConnectionMetric> {
  const client = await connect(env, 'app');
  try {
    const { rows } = await client.query<{
      total: string;
      active: string;
      idle: string;
      idle_in_transaction: string;
    }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE state = 'active')::text AS active,
              count(*) FILTER (WHERE state = 'idle')::text AS idle,
              count(*) FILTER (WHERE state = 'idle in transaction')::text AS idle_in_transaction
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    const row = rows[0];
    const total = Number(row?.total ?? '0') || 0;
    const metric: ConnectionMetric = {
      total,
      active: Number(row?.active ?? '0') || 0,
      idle: Number(row?.idle ?? '0') || 0,
      idleInTransaction: Number(row?.idle_in_transaction ?? '0') || 0,
      ceiling: CONNECTION_CEILING,
      alarm: CONNECTION_ALARM,
      alarming: total > CONNECTION_ALARM,
    };
    if (metric.alarming) {
      // One line, at the moment it crosses, with the denominator in it. A log
      // line saying only "connections high" is a line whose threshold nobody
      // can find six months later.
      logEvent({
        at: 'ops.connections',
        alarm: true,
        total: metric.total,
        idle_in_transaction: metric.idleInTransaction,
        threshold: CONNECTION_ALARM,
        ceiling: CONNECTION_CEILING,
        note: 'two Hyperdrive configs of ~100 each against a 209-connection origin',
      });
    }
    return metric;
  } finally {
    await client.end();
  }
}

/** The one-line summary `/health` reports. */
export const describeConnections = (metric: ConnectionMetric): string =>
  `${metric.total} of ${metric.ceiling} connections (${metric.idleInTransaction} idle in transaction), ` +
  `alarm at ${metric.alarm}`;
