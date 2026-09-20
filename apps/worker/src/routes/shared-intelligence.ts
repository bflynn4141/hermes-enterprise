import { createSharedIntelligenceProposalSchema } from '@hermes/shared';
import type { Context } from 'hono';
import type { Env } from '../env.js';
import {
  evaluateSharedIntelligence,
  listSharedIntelligence,
  prepareSharedIntelligenceProposal,
  revokeSharedIntelligenceProposal,
  saveSharedIntelligenceProposal,
  submitSharedIntelligenceProposal,
} from '../shared-intelligence/service.js';
import { inWorkspace, jsonBody, pathUuid } from './tenant.js';

export async function getSharedIntelligence(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.json(await inWorkspace(c, listSharedIntelligence));
}

export async function createSharedIntelligenceProposal(c: Context<{ Bindings: Env }>): Promise<Response> {
  const parsed = createSharedIntelligenceProposalSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) return c.json({ error: parsed.error.message, reason: 'bad_body' }, 400);
  const proposal = await inWorkspace(c, async (work) => {
    const prepared = await prepareSharedIntelligenceProposal(work, parsed.data);
    const assessment = await evaluateSharedIntelligence(c.env, prepared);
    return saveSharedIntelligenceProposal(work, prepared, assessment);
  });
  return c.json(proposal, 201);
}

export async function submitSharedIntelligence(c: Context<{ Bindings: Env }>): Promise<Response> {
  const proposalId = pathUuid(c, 'proposalId');
  return c.json(await inWorkspace(c, (work) => submitSharedIntelligenceProposal(work, proposalId)));
}

export async function revokeSharedIntelligence(c: Context<{ Bindings: Env }>): Promise<Response> {
  const proposalId = pathUuid(c, 'proposalId');
  return c.json(await inWorkspace(c, (work) => revokeSharedIntelligenceProposal(work, proposalId)));
}
