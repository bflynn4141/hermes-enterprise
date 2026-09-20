import { requireAgentContextAccess } from './agent-context-access.js';
import type { TenantWork } from '../routes/tenant.js';

/** Agent configuration follows the same private-context boundary as the
 * agent's sources and confirmed notes. An Admin role is configuration
 * authority only after the agent is actually accessible to that person. */
export async function requireAgentConfigAccess(work: TenantWork, agentId: string): Promise<void> {
  await requireAgentContextAccess(work, agentId);
}
