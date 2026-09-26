// GET /w/:ws/admin/agents — the Admin agent directory.
//
// Admin only. It lists every agent in the workspace with the configuration an
// Admin governs and no run content; the rule and its reasons live in
// src/domain/agent-governance-access.ts and src/domain/agent-directory.ts.
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { loadAgentDirectory } from '../domain/agent-directory.js';
import { inWorkspace } from './tenant.js';

export async function listAdminAgents(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await inWorkspace(c, async (work) => {
    work.requireAdmin('Viewing every agent');
    return loadAgentDirectory(work, c.env.HERMES_RUNTIME_AGENTS);
  });
  c.header('Cache-Control', 'no-store');
  return c.json(body);
}
