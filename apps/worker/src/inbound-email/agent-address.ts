// Every agent's own email address (decision C100).
//
// An agent gets one address, created with it or the first time anyone looks
// for it, whichever comes first, so agents made before C100 get theirs the
// same way. Mail to it is read by the agent, reviewed by its owner and the
// holders of its role, and approved replies go out from the same address.
//
// The address is the agent's name plus six random characters on the
// deployment's receiving domain: readable enough to recognise as Iris,
// unguessable enough that the domain is not a directory of agents.
import type { Tx } from '../db/client.js';
import { ensureInboxApprovals, inboxOwner, type InboxOwner, type InboxRow } from './suggestions.js';

/** The tools an address gives its agent. Named for what they do, see engine/tools.ts. */
export const INBOX_TOOL_NAMES = ['suggest_reply', 'suggest_handoff', 'get_workspace_context'];
export const inboxCapabilityScope = (inboxId: string): string => `email-inbox:${inboxId}`;

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function addressToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/** The readable half of an agent's address: its name, lowercased to letters, digits and hyphens. */
export function agentLocalPart(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 30).replace(/-+$/u, '');
  return /^[a-z0-9]/u.test(slug) && slug.length >= 2 ? slug : 'agent';
}

/** The deployment's receiving domain, or null when it has none. */
export function intakeDomain(raw: string | undefined): string | null {
  const domain = raw?.trim().toLowerCase();
  return domain && /^[a-z0-9.-]{3,253}$/u.test(domain) ? domain : null;
}

/**
 * The inbox gives its agent the suggestion tools and installs the approval
 * policies its replies use. Removing the inbox removes the capability row and
 * with it the authority.
 */
export async function grantInboxAuthority(tx: Tx, workspaceId: string, inbox: InboxRow, owner: InboxOwner): Promise<void> {
  const position = await tx.query<{ next: number }>(
    `SELECT COALESCE(max(position), -1)::int + 1 AS next FROM agent_capabilities WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, inbox.agent_id],
  );
  await tx.query(
    `INSERT INTO agent_capabilities (workspace_id, agent_id, kind, title, scope, tool_names, position)
     VALUES ($1,$2,'approves',$3,$4,$5::text[],$6)`,
    [workspaceId, inbox.agent_id, `Suggest replies and hand-offs for ${inbox.label}`.slice(0, 200),
      inboxCapabilityScope(inbox.id), INBOX_TOOL_NAMES, position.rows[0]?.next ?? 0],
  );
  await ensureInboxApprovals(tx, workspaceId, inbox, owner);
}

/**
 * The agent's own address, created now if it has none. Returns null when the
 * deployment has no receiving domain, or the agent is archived or has no
 * owner yet: its mail would have nobody to review it. Safe to call on every
 * read; a concurrent call finds the other's row.
 */
export async function ensureAgentInbox(
  tx: Tx,
  domain: string | null,
  workspaceId: string,
  agentId: string,
): Promise<string | null> {
  if (!domain) return null;
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM email_inboxes WHERE workspace_id=$1 AND agent_id=$2 AND kind='agent'`,
    [workspaceId, agentId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const agent = await tx.query<{ name: string; status: string }>(
    `SELECT name, status FROM agents WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, agentId],
  );
  const row = agent.rows[0];
  if (!row || !['draft', 'started'].includes(row.status)) return null;
  const owner = await inboxOwner(tx, workspaceId, agentId);
  if (!owner) return null;

  const label = (row.name.trim() || 'Agent').slice(0, 120);
  const address = `${agentLocalPart(row.name)}-${addressToken(6)}@${domain}`;
  const inserted = await tx.query<{ id: string; role_slug: string | null }>(
    `INSERT INTO email_inboxes (workspace_id, kind, role_slug, agent_id, address, label)
     VALUES ($1, 'agent', agent_team_role_slug($1, $2), $2, $3, $4)
     ON CONFLICT (workspace_id, agent_id) WHERE kind = 'agent' DO NOTHING
     RETURNING id, role_slug`,
    [workspaceId, agentId, address, label],
  );
  const created = inserted.rows[0];
  if (!created) {
    const raced = await tx.query<{ id: string }>(
      `SELECT id FROM email_inboxes WHERE workspace_id=$1 AND agent_id=$2 AND kind='agent'`,
      [workspaceId, agentId],
    );
    return raced.rows[0]?.id ?? null;
  }
  await grantInboxAuthority(tx, workspaceId,
    { id: created.id, address, label, role_slug: created.role_slug, agent_id: agentId, status: 'active', kind: 'agent' },
    owner);
  await tx.query(
    `INSERT INTO events (workspace_id, actor_type, kind) VALUES ($1, 'system', 'email_inbox.created')`,
    [workspaceId],
  );
  return created.id;
}

/**
 * Addresses for every live, owned agent that lacks one: all of them for an
 * Admin, or the viewer's own agents. Bounded, so a large workspace catches up
 * over a few page loads rather than in one request.
 */
export async function ensureAgentInboxes(
  tx: Tx,
  domain: string | null,
  workspaceId: string,
  scope: { admin: boolean; userId: string },
): Promise<void> {
  if (!domain) return;
  const missing = await tx.query<{ id: string }>(
    `SELECT a.id FROM agents a
       JOIN agent_owners ao ON ao.workspace_id=a.workspace_id AND ao.agent_id=a.id
       JOIN members m ON m.workspace_id=ao.workspace_id AND m.id=ao.member_id AND m.status='active'
      WHERE a.workspace_id=$1 AND a.status IN ('draft','started')
        AND ($2 OR m.user_id=$3)
        AND NOT EXISTS (SELECT 1 FROM email_inboxes i WHERE i.workspace_id=a.workspace_id AND i.agent_id=a.id AND i.kind='agent')
      ORDER BY a.created_at
      LIMIT 25`,
    [workspaceId, scope.admin, scope.userId],
  );
  for (const agent of missing.rows) await ensureAgentInbox(tx, domain, workspaceId, agent.id);
}
