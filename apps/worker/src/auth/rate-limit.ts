// Per-user rate limits.
//
// `rate_counters` is the one workspace-shaped table outside row-level security,
// and deliberately so (decision 4 in docs/DECISIONS.md): a limit that can be
// evaded by failing to set the tenant key is not a limit, and the counter is
// keyed by user first so nobody can spread a burst across workspaces either.
//
// The window is a bucket rather than a sliding log: it costs one upsert instead
// of a row per attempt, and the failure mode — up to twice the limit across a
// bucket boundary — is the right trade for a limit whose job is to stop a
// runaway script rather than to meter a paying customer.
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/errors.js';

/** Actions with no workspace yet (creating one) count against this key. */
export const PLATFORM_WORKSPACE_ID = '00000000-0000-4000-8000-000000000000';

export interface RateLimit {
  readonly action: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The limits section 5 of the plan names. M2 enforces the ones it can reach. */
export const LIMITS = {
  createWorkspace: { action: 'workspace.create', limit: 3, windowSeconds: 86_400 },
  invite: { action: 'member.invite', limit: 20, windowSeconds: 3_600 },
  share: { action: 'session.share', limit: 10, windowSeconds: 60 },
  // 10 uploads a minute, per the plan. Counted at declaration rather than at
  // completion: a script that mints a thousand presigned URLs and never uses
  // one has still asked us to sign a thousand URLs.
  upload: { action: 'attachment.create', limit: 10, windowSeconds: 60 },
  /**
   * Accepting an invitation, which is the one authenticated route that takes an
   * opaque secret and tells the caller whether it was right. Without a limit it
   * is a free guessing oracle — and each attempt is two Postgres connections,
   * so it is a connection amplifier as well. Counted on a plain client rather
   * than inside a transaction (see `acceptInvitation`), so a wrong guess is
   * *not* refunded: refunding the failures would limit only the successes,
   * which is the opposite of what a guessing limit is for.
   */
  acceptInvitation: { action: 'invitation.accept', limit: 10, windowSeconds: 3_600 },
  /**
   * Reading an invitation's workspace name before accepting takes the same
   * opaque secret, so it is the same oracle; a separate, looser bucket keeps a
   * few page refreshes from spending the ten accept attempts.
   */
  previewInvitation: { action: 'invitation.preview', limit: 60, windowSeconds: 3_600 },
} as const satisfies Record<string, RateLimit>;

/**
 * Count this attempt, and refuse it if it is over the limit.
 *
 * Counted inside the caller's transaction, so an attempt that fails for another
 * reason does not spend the caller's budget: the rollback takes the count with
 * it. A limit that punished someone for our own 500 would be a limit that
 * teaches people to retry harder.
 */
export async function consumeRate(
  tx: Tx,
  userId: string,
  workspaceId: string | null,
  limit: RateLimit,
): Promise<void> {
  const { rows } = await tx.query<{ count: number }>(
    `INSERT INTO rate_counters (user_id, workspace_id, action, window_start, count)
     VALUES ($1, $2, $3, to_timestamp(floor(extract(epoch FROM now()) / $4) * $4), 1)
     ON CONFLICT (user_id, action, window_start, workspace_id)
       DO UPDATE SET count = rate_counters.count + 1
     RETURNING count`,
    [userId, workspaceId ?? PLATFORM_WORKSPACE_ID, limit.action, limit.windowSeconds],
  );
  const count = rows[0]?.count ?? 0;
  if (count > limit.limit) {
    throw new RouteError(
      `${limit.action} is limited to ${limit.limit} per ${limit.windowSeconds} seconds`,
      'rate_limited',
      429,
    );
  }
}
