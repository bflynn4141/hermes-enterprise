// Governance access: an Admin's authority over what an agent may do, kept
// apart from what the agent has done.
//
// Decision (Brian, September 2026): an Admin may change the role and the
// permissions of any agent in the workspace, including another member's
// private agent, but must never read that agent's conversations. Two checks
// hold the two halves:
//
//   * `requireAgentConfigAccess` / `requireAgentContextAccess` guard anything
//     that carries the agent's work: sessions, messages, run transcripts,
//     parked tool-call arguments, context notes, instructions proposed by runs.
//     They are unchanged and still refuse an Admin who is not the agent's
//     owner or principal.
//   * `requireAgentGovernanceAccess` (this file) guards only configuration that
//     is safe to show without that content: the operation-approval switches
//     and an enterprise skill assignment's state, config and schedule. Call it
//     route by route. It is not a looser `requireAgentConfigAccess`, and a
//     route that returns anything run-derived must not use it.
//
// Someone with content access keeps exactly the behaviour they had. An Admin
// without it gets governance-only access: reads leave the run content out, and
// the routes ask for a recent sign-in before a change, the same bar as
// changing a member's role, because it alters another person's agent while
// they are not there.
import { RouteError } from '../routes/errors.js';
import type { TenantWork } from '../routes/tenant.js';
import { hasAgentContextAccess } from './agent-context-access.js';

export interface AgentGovernanceAccess {
  /** True when the viewer may also read the agent's own work. */
  readonly conversations: boolean;
}

export async function requireAgentGovernanceAccess(work: TenantWork, agentId: string): Promise<AgentGovernanceAccess> {
  if (await hasAgentContextAccess(work, agentId)) return { conversations: true };
  // A Member still gets the same 404 as before for someone else's agent, so
  // this path reveals nothing new to them about which agents exist.
  if (work.role !== 'admin') throw new RouteError('No accessible agent context', 'not_found', 404);
  const exists = await work.tx.query('SELECT 1 FROM agents WHERE workspace_id=$1 AND id=$2', [work.workspaceId, agentId]);
  if (!exists.rows[0]) throw new RouteError('No accessible agent context', 'not_found', 404);
  return { conversations: false };
}
