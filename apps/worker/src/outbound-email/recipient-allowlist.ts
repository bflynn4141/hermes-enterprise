import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';

// Who a deployment may send approved email to (C100). With
// AGENT_EMAIL_RECIPIENT_MODE=members (staging), only the workspace's members:
// people who accepted an invitation and are still active. Someone invited but
// not yet joined is not a member. The list is read at send time, so it follows
// the member list with nothing to keep in sync, and removing someone stops
// mail to them at once.

export async function recipientAllowed(
  tx: Tx,
  env: Pick<Env, 'AGENT_EMAIL_RECIPIENT_MODE'>,
  workspaceId: string,
  address: string,
): Promise<boolean> {
  if (!env.AGENT_EMAIL_RECIPIENT_MODE) return true;
  // Any other value fails closed: a typo must not send to everyone.
  if (env.AGENT_EMAIL_RECIPIENT_MODE !== 'members') return false;
  const found = await tx.query(
    `SELECT 1 FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.status = 'active' AND lower(u.email) = $2
      LIMIT 1`,
    [workspaceId, address.trim().toLowerCase()],
  );
  return found.rowCount === 1;
}
