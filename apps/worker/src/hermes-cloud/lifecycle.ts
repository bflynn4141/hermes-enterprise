import {
  callCloudManagementTool,
  CloudManagementError,
  type CloudManagementCredential,
  type CloudToolContract,
} from './management.js';

type ObjectValue = Record<string, unknown>;
type Credential = Pick<CloudManagementCredential, 'accessToken' | 'scope'>;

const REGIONS = ['iad', 'sjc', 'lhr', 'nrt', 'syd', 'gru'] as const;
export type CloudRegion = typeof REGIONS[number];

export interface CloudAgentRecord {
  id: string;
  name: string;
  status: string;
  region: string;
  model: string;
  createdAt: string;
  health: string;
  healthDetail: string;
  dashboardUrl: string;
  lastError: string | null;
  scheduledDeletionAt: string | null;
}

export interface CloudCreateSpec {
  operationId: string;
  size: string;
  region?: CloudRegion;
  model?: string;
  env?: Record<string, string>;
}

export type CloudCreationDispatchResult =
  | { kind: 'confirmed'; agent: CloudAgentRecord; reconciled: boolean }
  | { kind: 'reconciliation_required'; cloudName: string };

export type CloudCreationReconciliation =
  | { kind: 'confirmed'; agent: CloudAgentRecord }
  | { kind: 'pending'; cloudName: string };

export interface CloudProvisioningSupport {
  lifecycle: boolean;
  organizationUsage: boolean;
  unattendedCredentials: boolean;
  governedBootstrap: false;
  automaticProvisioningReady: false;
}

const invalid = (): never => { throw new CloudManagementError('cloud_contract_invalid'); };
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as ObjectValue;
}
function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value)) return invalid();
  return value;
}
function nullableText(value: unknown, max = 2048): string | null {
  return value === null ? null : text(value, max);
}

function parseCloudAgent(value: unknown): CloudAgentRecord {
  const agent = object(value);
  const dashboardUrl = text(agent.dashboardUrl, 4096);
  let url: URL;
  try { url = new URL(dashboardUrl); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password) return invalid();
  return {
    id: text(agent.id, 255),
    name: text(agent.name, 64),
    status: text(agent.status, 64),
    region: text(agent.region, 64),
    model: text(agent.model, 255),
    createdAt: text(agent.createdAt, 64),
    health: text(agent.health, 64),
    healthDetail: text(agent.healthDetail, 2048),
    dashboardUrl: url.href,
    lastError: nullableText(agent.lastError, 2048),
    scheduledDeletionAt: nullableText(agent.scheduledDeletionAt, 64),
  };
}

function parseAgentList(payload: ObjectValue): CloudAgentRecord[] {
  if (!Array.isArray(payload.agents) || payload.agents.length > 500) return invalid();
  return payload.agents.map(parseCloudAgent);
}

/** Stable provider-visible name used only as a reconciliation key. */
export function cloudAgentProvisioningName(operationId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) return invalid();
  return `hermes-${operationId.toLowerCase()}`;
}

function createArguments(spec: CloudCreateSpec): ObjectValue {
  const name = cloudAgentProvisioningName(spec.operationId);
  const size = text(spec.size, 64);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(size)) return invalid();
  if (spec.region !== undefined && !REGIONS.includes(spec.region)) return invalid();
  const env = spec.env === undefined ? undefined : object(spec.env);
  if (env && Object.keys(env).length > 64) return invalid();
  let envBytes = 0;
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || typeof value !== 'string' || value.length > 8192 || /\0/.test(value)) return invalid();
    envBytes += key.length + value.length;
  }
  if (envBytes > 64 * 1024) return invalid();
  return {
    action: 'create', name, size,
    ...(spec.region === undefined ? {} : { region: spec.region }),
    ...(spec.model === undefined ? {} : { model: text(spec.model, 255) }),
    ...(env === undefined ? {} : { env }),
  };
}

export async function listCloudAgents(credential: Credential, fetcher: typeof fetch = fetch): Promise<CloudAgentRecord[]> {
  return parseAgentList(await callCloudManagementTool(credential, 'agents', { action: 'list' }, fetcher));
}

async function matchingAgent(
  credential: Credential,
  operationId: string,
  fetcher: typeof fetch,
): Promise<CloudAgentRecord | null> {
  const name = cloudAgentProvisioningName(operationId);
  const matches = (await listCloudAgents(credential, fetcher)).filter(agent => agent.name === name);
  if (matches.length > 1) return invalid();
  return matches[0] ?? null;
}

/**
 * Read-only reconciliation for an operation already persisted as creating.
 * A missing instance remains pending; this function never authorizes replay.
 */
export async function reconcileCloudAgentCreation(
  credential: Credential,
  operationId: string,
  fetcher: typeof fetch = fetch,
): Promise<CloudCreationReconciliation> {
  const agent = await matchingAgent(credential, operationId, fetcher);
  return agent
    ? { kind: 'confirmed', agent }
    : { kind: 'pending', cloudName: cloudAgentProvisioningName(operationId) };
}

/**
 * Dispatch exactly once, only after the durable operation has entered its
 * `creating` state. Callers must use reconcileCloudAgentCreation on every
 * subsequent wake. The provider exposes no idempotency key for create.
 */
export async function dispatchCloudAgentCreation(
  credential: Credential,
  spec: CloudCreateSpec,
  fetcher: typeof fetch = fetch,
): Promise<CloudCreationDispatchResult> {
  const existing = await matchingAgent(credential, spec.operationId, fetcher);
  if (existing) return { kind: 'confirmed', agent: existing, reconciled: true };
  const args = createArguments(spec);
  try {
    const created = parseCloudAgent(object(await callCloudManagementTool(credential, 'agent', args, fetcher)).agent);
    if (created.name !== args.name) return invalid();
    return { kind: 'confirmed', agent: created, reconciled: false };
  } catch (error) {
    if (error instanceof CloudManagementError && error.reason === 'cloud_call_outcome_unknown') {
      return { kind: 'reconciliation_required', cloudName: String(args.name) };
    }
    throw error;
  }
}

function actionSet(contract: CloudToolContract | undefined): Set<string> {
  if (!contract) return new Set();
  const properties = object(contract.inputSchema.properties);
  const action = object(properties.action);
  if (!Array.isArray(action.enum) || action.enum.some(value => typeof value !== 'string')) return new Set();
  return new Set(action.enum as string[]);
}

function hasActions(contracts: CloudToolContract[], name: string, actions: string[]): boolean {
  const values = actionSet(contracts.find(contract => contract.name === name));
  return actions.every(action => values.has(action));
}

/**
 * Derive only capabilities proven by authenticated tool schemas. Cloud does
 * not currently expose governed plugin/profile installation, so connection,
 * billing and lifecycle support still cannot claim end-to-end readiness.
 */
export function inspectCloudProvisioningSupport(contracts: CloudToolContract[]): CloudProvisioningSupport {
  return {
    lifecycle: hasActions(contracts, 'agents', ['list', 'get', 'status', 'cost_estimate']) &&
      hasActions(contracts, 'agent', ['create', 'start', 'stop', 'restart', 'destroy', 'update_env', 'update_image']),
    organizationUsage: hasActions(contracts, 'usage', ['transactions', 'hourly', 'daily']),
    unattendedCredentials: hasActions(contracts, 'service_credentials', ['create', 'list', 'revoke']),
    governedBootstrap: false,
    automaticProvisioningReady: false,
  };
}
