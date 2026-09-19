#!/usr/bin/env node
/**
 * Read-only verifier for stored evidence from a prepared Partnerships -> Finance rehearsal.
 *
 * This script never starts a run or changes hosted state. It performs GETs with
 * two independently captured WorkOS browser states and verifies the stored
 * identities, assignments, native-shaped traces, handoff, human decision and
 * saved invoice. These application records cannot independently prove that a
 * live provider or native process produced them. It is deliberately separate
 * from e2e-live.mjs, whose fake auth and scripted provider are invalid even as
 * candidate acceptance evidence.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PLACEHOLDER = /(^|[._-])(example|replace|todo|placeholder)([._-]|$)/i;
const NON_NATIVE_EVIDENCE = /\b(scripted|fixture|mock)\b/i;
const CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FINANCE_CHECK_CODES = Object.freeze([
  'duplicate', 'currency', 'amount', 'engagement_authorization',
  'engagement_validity', 'invoice_source', 'engagement_source',
]);

export const ROLE_CONTRACTS = Object.freeze({
  partnerships: {
    skillKey: 'partner-program-screening',
    runtimeName: 'enterprise_bridge:partner-program-screening-v1-8',
    version: '1.8.0',
    artifactDigest: 'sha256:281bbfff95d40e202c3ced5d1cb30ebf432868bee100d0c2a647faa40757a9e5',
    roleTemplate: 'partnerships-agent',
    capabilities: Object.freeze([
      'partner.discovery.read',
      'partner.review.prepare',
      'partner.outreach.draft',
      'partner.records.qualification.write',
      'partner.handoff.publish',
    ]),
    tools: Object.freeze([
      'list_partner_candidates',
      'get_partner_candidate',
      'list_requests',
      'get_request',
      'get_approval_status',
      'get_document_text',
      'save_review_note',
      'set_context_field',
      'ask_for_context',
      'set_focus',
      'propose_request',
      'propose_approval',
      'propose_instruction',
      'publish_partner_invoice_review',
    ]),
    requiredTool: 'publish_partner_invoice_review',
    resultSource: 'workspace.partner_invoice_intakes',
  },
  finance: {
    skillKey: 'partner-invoice-review',
    runtimeName: 'enterprise_bridge:partner-invoice-review',
    version: '1.0.1',
    artifactDigest: 'sha256:bdb13d70f7a603f92eb47fc2d1c057c82f26658e61df8cf357790f23875753e4',
    roleTemplate: 'finance-agent',
    capabilities: Object.freeze([
      'partner.shared.read',
      'partner.invoice.read',
      'partner.invoice.review.prepare',
    ]),
    tools: Object.freeze(['get_partner_handoff_result', 'list_requests', 'get_request']),
    requiredTool: 'get_partner_handoff_result',
    resultSource: 'workspace.partner_handoff_results',
  },
});

for (const contract of Object.values(ROLE_CONTRACTS)) {
  // `skill_view` is a native, package-bounded readiness tool. The Worker does
  // not place it in a run's enterprise-tool snapshot, so keep the two exact
  // inventories explicit rather than making a three-tool trace look like a
  // four-tool native attestation.
  Object.defineProperty(contract, 'readinessTools', {
    value: Object.freeze([...contract.tools, 'skill_view']),
    enumerable: true,
  });
  Object.freeze(contract);
}

export class AcceptanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AcceptanceError';
  }
}

const refuse = (condition, message) => {
  if (!condition) throw new AcceptanceError(message);
};

const exactNames = (actual, expected, label) => {
  refuse(Array.isArray(actual), `${label} is not an array`);
  refuse(new Set(actual).size === actual.length, `${label} contains duplicates`);
  const left = [...actual].sort();
  const right = [...expected].sort();
  refuse(JSON.stringify(left) === JSON.stringify(right), `${label} does not match the reviewed inventory`);
};

const object = (value, label) => {
  refuse(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} is missing`);
  return value;
};

const string = (value, label) => {
  refuse(typeof value === 'string' && value.length > 0, `${label} is missing`);
  return value;
};

const uuid = (value, label) => {
  refuse(typeof value === 'string' && UUID.test(value), `${label} must be a UUID`);
  return value;
};

const same = (actual, expected, label) =>
  refuse(actual === expected, `${label} does not match the prepared rehearsal`);

const roleEntry = (manifest, role) => object(object(manifest.roles, 'roles')[role], `roles.${role}`);

const inside = (parent, candidate) => {
  const relative = path.relative(parent, path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export function validateAcceptanceManifest(input) {
  const manifest = object(input, 'manifest');
  same(manifest.schema_version, 1, 'schema_version');
  let base;
  try { base = new URL(string(manifest.base_url, 'base_url')); }
  catch { throw new AcceptanceError('base_url must be an absolute URL'); }
  refuse(base.protocol === 'https:', 'base_url must use HTTPS');
  refuse(!base.username && !base.password && !base.search && !base.hash, 'base_url cannot contain credentials, query or fragment');
  refuse(!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'local endpoints are not staging acceptance evidence');
  base.pathname = base.pathname.replace(/\/$/, '');

  for (const field of ['workspace_id', 'intake_event_id', 'handoff_id', 'request_id', 'decision_id', 'document_id']) {
    uuid(manifest[field], field);
  }
  refuse(SHA256.test(manifest.payload_hash), 'payload_hash must be a sha256 digest');
  same(manifest.input_provenance, 'sample', 'input_provenance');

  for (const role of Object.keys(ROLE_CONTRACTS)) {
    const entry = roleEntry(manifest, role);
    for (const field of ['user_id', 'agent_id', 'run_id']) uuid(entry[field], `roles.${role}.${field}`);
    string(entry.email, `roles.${role}.email`);
    refuse(entry.email.includes('@') && !PLACEHOLDER.test(entry.email), `roles.${role}.email must name the expected real principal`);
    string(entry.runtime_profile, `roles.${role}.runtime_profile`);
    refuse(!NON_NATIVE_EVIDENCE.test(entry.runtime_profile), `roles.${role}.runtime_profile names non-native evidence`);
    const authPath = string(entry.auth_state, `roles.${role}.auth_state`);
    refuse(path.isAbsolute(authPath), `roles.${role}.auth_state must be an absolute path outside the repository`);
    refuse(!inside(CHECKOUT_ROOT, authPath), `roles.${role}.auth_state must stay outside the repository`);
  }
  const partnerships = roleEntry(manifest, 'partnerships');
  const finance = roleEntry(manifest, 'finance');
  refuse(partnerships.user_id !== finance.user_id, 'the two roles must name distinct human principals');
  refuse(partnerships.email.toLowerCase() !== finance.email.toLowerCase(), 'the two roles must name distinct principal emails');
  refuse(partnerships.agent_id !== finance.agent_id, 'the two roles must name distinct agents');
  refuse(partnerships.run_id !== finance.run_id, 'the two roles must name distinct native runs');
  refuse(partnerships.runtime_profile !== finance.runtime_profile, 'the two roles must name distinct native profiles');
  refuse(realpathIfPresent(partnerships.auth_state) !== realpathIfPresent(finance.auth_state), 'the two roles must use distinct auth-state files');
  return { ...manifest, base_url: base.toString().replace(/\/$/, '') };
}

function realpathIfPresent(file) {
  return existsSync(file) ? realpathSync(file) : path.resolve(file);
}

export function loadSecureAuthState(file, baseUrl) {
  refuse(path.isAbsolute(file), 'auth-state path must be absolute');
  refuse(existsSync(file), `auth-state file is missing: ${file}`);
  const stat = lstatSync(file);
  refuse(stat.isFile() && !stat.isSymbolicLink(), `auth-state path must be a regular file: ${file}`);
  refuse((stat.mode & 0o077) === 0, `auth-state file must not be group/world accessible: ${file}`);
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new AcceptanceError(`auth-state file is not valid JSON: ${file}`); }
  const hostname = new URL(baseUrl).hostname;
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const sessions = cookies.filter((cookie) => {
    const domain = String(cookie?.domain ?? '').replace(/^\./, '');
    return cookie?.httpOnly === true && cookie?.secure === true &&
      (hostname === domain || hostname.endsWith(`.${domain}`)) &&
      typeof cookie?.value === 'string' && cookie.value.length > 0;
  });
  refuse(sessions.length > 0, `auth-state file has no secure HttpOnly cookie for ${hostname}: ${file}`);
  return {
    state,
    fingerprint: createHash('sha256').update(sessions
      .map((cookie) => `${cookie.name}\0${cookie.domain}\0${cookie.path}\0${cookie.value}`).sort().join('\n')).digest('hex'),
  };
}

function verifyHealth(health) {
  object(health, 'health');
  same(health.status, 'ok', 'health.status');
  refuse(typeof health.version === 'string' && health.version.endsWith('+staging'), 'health.version is not a staging deployment');
  const checks = new Map((Array.isArray(health.checks) ? health.checks : []).map((check) => [check?.name, check?.ok]));
  for (const name of ['auth:config', 'workos:jwks', 'hermes:runs']) {
    same(checks.get(name), true, `health check ${name}`);
  }
}

function verifySession(session, manifest, role) {
  object(session, `${role} auth session`);
  const expected = roleEntry(manifest, role);
  same(session.workspace?.id, manifest.workspace_id, `${role} session workspace`);
  same(session.user?.id, expected.user_id, `${role} session user`);
  same(String(session.user?.email ?? '').toLowerCase(), expected.email.toLowerCase(), `${role} session email`);
}

function roleAgent(workflow, role) {
  const key = ROLE_CONTRACTS[role].skillKey;
  const matches = (Array.isArray(workflow.agents) ? workflow.agents : []).filter((agent) => agent?.skill_key === key);
  refuse(matches.length === 1, `${role} workflow agent is not unique`);
  return matches[0];
}

function verifyWorkflow(workflow, manifest, role) {
  object(workflow, `${role} workflow`);
  same(workflow.configured, true, `${role} workflow configured`);
  same(workflow.admission_state, 'enabled', `${role} workflow admission`);
  same(workflow.viewer_role, role, `${role} workflow viewer role`);
  const contract = ROLE_CONTRACTS[role];
  const expected = roleEntry(manifest, role);
  const agent = roleAgent(workflow, role);
  same(agent.id, expected.agent_id, `${role} agent id`);
  same(agent.principal_user_id, expected.user_id, `${role} principal id`);
  same(agent.role_template?.key, contract.roleTemplate, `${role} role template`);
  same(agent.role_template?.version, '1.0.0', `${role} role template version`);
  same(agent.skill_version, contract.version, `${role} agent skill version`);
  same(agent.assignment_state, 'active', `${role} assignment state`);
  same(agent.schedule_enabled, false, `${role} schedule state`);
  exactNames(agent.capabilities, contract.capabilities, `${role} workflow capabilities`);
  const readiness = (Array.isArray(workflow.readiness) ? workflow.readiness : []).find((entry) => entry?.role === role);
  refuse(Boolean(readiness), `${role} readiness is missing`);
  same(readiness.configured, true, `${role} readiness configured`);
  same(readiness.assignment_state, 'active', `${role} readiness assignment state`);
  same(readiness.native_status, 'ready', `${role} native status`);
  same(readiness.skill_key, contract.skillKey, `${role} readiness skill key`);
  same(readiness.skill_version, contract.version, `${role} readiness skill version`);
  same(readiness.artifact_digest, contract.artifactDigest, `${role} readiness artifact`);
  exactNames(readiness.missing, [], `${role} readiness missing list`);
  return agent;
}

function verifyAssignment(assignment, workflowAgent, manifest, role) {
  object(assignment, `${role} assignment`);
  const contract = ROLE_CONTRACTS[role];
  const expected = roleEntry(manifest, role);
  same(assignment.id, workflowAgent.assignment_id, `${role} assignment id`);
  same(assignment.agent_id, expected.agent_id, `${role} assignment agent`);
  same(assignment.team?.slug, role, `${role} assignment team`);
  same(assignment.skill_key, contract.skillKey, `${role} skill key`);
  same(assignment.runtime_name, contract.runtimeName, `${role} runtime skill name`);
  same(assignment.version, contract.version, `${role} assignment version`);
  same(assignment.artifact_digest, contract.artifactDigest, `${role} assignment artifact`);
  same(assignment.state, 'active', `${role} assignment state`);
  same(assignment.revision, workflowAgent.assignment_revision, `${role} assignment revision`);
  same(assignment.schedule?.enabled, false, `${role} assignment schedule`);
  same(assignment.human_review_required, true, `${role} human review policy`);
  exactNames(assignment.capability_grants, contract.capabilities, `${role} assignment capabilities`);
}

function callArguments(call, label) {
  refuse(typeof call.arguments === 'string', `${label} arguments are missing`);
  try { return object(JSON.parse(call.arguments), `${label} arguments`); }
  catch { throw new AcceptanceError(`${label} arguments are not valid JSON`); }
}

function toolResultEnvelope(call, contract, label) {
  const raw = string(call.result, `${label} result`);
  refuse(!NON_NATIVE_EVIDENCE.test(raw), `${label} result contains a scripted/fixture marker`);
  let envelope;
  try { envelope = object(JSON.parse(raw), `${label} result envelope`); }
  catch { throw new AcceptanceError(`${label} result is not a valid JSON envelope`); }
  same(envelope.tool, contract.requiredTool, `${label} result tool`);
  same(envelope.source, contract.resultSource, `${label} result source`);
  same(envelope.untrusted, true, `${label} result trust marker`);
  refuse(typeof envelope.retrieved_at === 'string' && !Number.isNaN(Date.parse(envelope.retrieved_at)), `${label} result retrieval time is missing`);
  refuse(envelope.truncated !== true && !('data_text' in envelope), `${label} result envelope is truncated`);
  return object(envelope.data, `${label} result data`);
}

function verifyPassedFinanceChecks(checks, label) {
  refuse(Array.isArray(checks), `${label} are missing`);
  exactNames(checks.map((check) => check?.code), FINANCE_CHECK_CODES, `${label} codes`);
  refuse(checks.every((check) => check?.status === 'passed' && typeof check?.message === 'string' && check.message.length > 0), `${label} are not typed passed checks`);
}

function verifyTrace(trace, manifest, role) {
  object(trace, `${role} trace`);
  const contract = ROLE_CONTRACTS[role];
  const expected = roleEntry(manifest, role);
  same(trace.run_id, expected.run_id, `${role} run id`);
  same(trace.agent_id, expected.agent_id, `${role} trace agent`);
  same(trace.runtime_kind, 'hermes', `${role} runtime kind`);
  same(trace.runtime_profile, expected.runtime_profile, `${role} runtime profile`);
  string(trace.runtime_run_id, `${role} native run id`);
  string(trace.runtime_session_id, `${role} native session id`);
  same(trace.status, 'completed', `${role} run status`);
  const model = string(trace.model_id, `${role} model id`);
  refuse(!NON_NATIVE_EVIDENCE.test(model), `${role} model id names scripted or fixture evidence`);
  exactNames(trace.allowed_tools, contract.tools, `${role} allowed tools`);
  const calls = (Array.isArray(trace.tool_calls) ? trace.tool_calls : []).filter((call) => call?.name === contract.requiredTool);
  refuse(calls.length === 1, `${role} must have exactly one stored ${contract.requiredTool} call`);
  const call = calls[0];
  same(call.truncated, false, `${role} required tool result truncation`);
  const args = callArguments(call, `${role} required tool`);
  if (role === 'partnerships') {
    exactNames(Object.keys(args), ['intake_event_id', 'expected_payload_hash'], 'partnerships publish arguments');
    same(args.intake_event_id, manifest.intake_event_id, 'partnerships intake event');
    same(args.expected_payload_hash, manifest.payload_hash, 'partnerships payload hash');
  } else {
    exactNames(Object.keys(args), ['handoff_id'], 'finance result arguments');
    same(args.handoff_id, manifest.handoff_id, 'finance handoff argument');
  }
  const data = toolResultEnvelope(call, contract, `${role} required tool`);
  same(data.handoff_id, manifest.handoff_id, `${role} tool result handoff id`);
  if (role === 'partnerships') {
    exactNames(Object.keys(data), ['handoff_id', 'job_id', 'created'], 'partnerships tool result fields');
    uuid(data.job_id, 'partnerships tool result job id');
    refuse(typeof data.created === 'boolean', 'partnerships tool result created flag is missing');
  } else {
    same(data.kind, 'checks_passed', 'finance tool result kind');
    same(data.request_id, manifest.request_id, 'finance tool result request id');
    same(data.input_provenance, 'sample', 'finance tool result provenance');
    verifyPassedFinanceChecks(data.checks, 'finance tool result checks');
    same(data.outcome?.delivery, 'delivered', 'finance tool result delivery');
    same(data.outcome?.validation, 'passed', 'finance tool result validation');
    same(data.outcome?.agent_explanation, 'running', 'finance tool result explanation state');
    same(data.outcome?.human_decision, 'pending', 'finance tool result decision state');
    same(data.outcome?.acknowledgment, 'pending', 'finance tool result acknowledgment state');
  }
}

function verifyOutcome(evidence, manifest) {
  const financeWorkflow = evidence.roles.finance.workflow;
  const handoffs = (Array.isArray(financeWorkflow.handoffs) ? financeWorkflow.handoffs : [])
    .filter((handoff) => handoff?.id === manifest.handoff_id);
  refuse(handoffs.length === 1, 'prepared handoff is missing or duplicated in Finance workflow view');
  const handoff = handoffs[0];
  same(handoff.current, true, 'handoff current state');
  same(handoff.input_provenance, 'sample', 'handoff input provenance');
  same(handoff.simulated, false, 'handoff simulated flag');
  same(handoff.request_id, manifest.request_id, 'handoff request id');
  same(handoff.result_kind, 'checks_passed', 'handoff result kind');
  verifyPassedFinanceChecks(handoff.checks, 'handoff checks');
  same(handoff.outcome?.validation, 'passed', 'handoff validation outcome');
  same(handoff.outcome?.agent_explanation, 'completed', 'Finance explanation outcome');
  same(handoff.outcome?.human_decision, 'approved', 'Finance human decision');
  same(handoff.outcome?.acknowledgment, 'delivered', 'acknowledgment outcome');
  string(handoff.decided_at, 'handoff decision time');
  const acknowledgment = object(handoff.acknowledgment, 'acknowledgment');
  same(acknowledgment.handoff_id, manifest.handoff_id, 'acknowledgment handoff id');
  same(acknowledgment.outcome, 'invoice_draft_saved', 'acknowledgment outcome');
  same(acknowledgment.result_code, 'approved', 'acknowledgment result code');
  same(acknowledgment.delivery_status, 'delivered', 'acknowledgment delivery');

  const result = object(evidence.handoff_result, 'handoff result');
  same(result.kind, 'checks_passed', 'authoritative result kind');
  same(result.handoff_id, manifest.handoff_id, 'authoritative result handoff id');
  same(result.request_id, manifest.request_id, 'authoritative result request id');
  same(result.input_provenance, 'sample', 'authoritative result provenance');
  same(result.outcome?.validation, 'passed', 'authoritative result validation');
  same(result.outcome?.human_decision, 'approved', 'authoritative result decision');
  same(result.outcome?.acknowledgment, 'delivered', 'authoritative result acknowledgment');
  verifyPassedFinanceChecks(result.checks, 'authoritative checks');

  const request = object(evidence.request, 'request');
  same(request.id, manifest.request_id, 'request id');
  same(request.kind, 'invoice', 'request kind');
  same(request.status, 'created', 'approved request status');
  same(request.decision_id, manifest.decision_id, 'request decision id');
  string(request.decided_at, 'request decided_at');
  same(request.payload?.workflow_provenance?.handoff_id, manifest.handoff_id, 'request workflow handoff id');
  const sourceSessions = request.payload?.workflow_provenance?.source_sessions;
  refuse(Array.isArray(sourceSessions) && sourceSessions.length === 2, 'request must retain both source sessions');
  refuse(sourceSessions.every((source) => source?.simulated === false), 'request source sessions are marked simulated');

  const documents = Array.isArray(evidence.documents?.items) ? evidence.documents.items : [];
  const matches = documents.filter((document) => document?.id === manifest.document_id);
  refuse(matches.length === 1, 'saved invoice document is missing or duplicated');
  const document = matches[0];
  same(document.kind, 'invoice', 'saved document kind');
  same(document.request_id, manifest.request_id, 'saved document request id');
  same(document.payload?.workflow_provenance?.handoff_id, manifest.handoff_id, 'saved document handoff id');
}

export function verifyAcceptanceEvidence(evidence, rawManifest) {
  const manifest = validateAcceptanceManifest(rawManifest);
  verifyHealth(evidence.health);
  const agents = {};
  for (const role of Object.keys(ROLE_CONTRACTS)) {
    const roleEvidence = object(object(evidence.roles, 'evidence.roles')[role], `evidence.roles.${role}`);
    verifySession(roleEvidence.session, manifest, role);
    agents[role] = verifyWorkflow(roleEvidence.workflow, manifest, role);
    verifyAssignment(roleEvidence.assignment, agents[role], manifest, role);
    verifyTrace(roleEvidence.trace, manifest, role);
  }
  verifyOutcome(evidence, manifest);
  return Object.freeze({
    schema_version: 1,
    verified_at: new Date().toISOString(),
    deployment: { base_url: manifest.base_url, health_version: evidence.health.version },
    workspace_id: manifest.workspace_id,
    input_provenance: 'sample',
    intake_event_id: manifest.intake_event_id,
    payload_hash: manifest.payload_hash,
    handoff_id: manifest.handoff_id,
    request_id: manifest.request_id,
    decision_id: manifest.decision_id,
    document_id: manifest.document_id,
    roles: Object.fromEntries(Object.keys(ROLE_CONTRACTS).map((role) => [role, {
      user_id: roleEntry(manifest, role).user_id,
      email: roleEntry(manifest, role).email,
      agent_id: roleEntry(manifest, role).agent_id,
      runtime_profile: roleEntry(manifest, role).runtime_profile,
      run_id: roleEntry(manifest, role).run_id,
      native_run_id: evidence.roles[role].trace.runtime_run_id,
      native_session_id: evidence.roles[role].trace.runtime_session_id,
      skill: {
        name: ROLE_CONTRACTS[role].runtimeName,
        version: ROLE_CONTRACTS[role].version,
        artifact_digest: ROLE_CONTRACTS[role].artifactDigest,
      },
      expected_readiness_tools: [...ROLE_CONTRACTS[role].readinessTools],
      stored_run_tools: [...ROLE_CONTRACTS[role].tools],
    }])),
    result: 'stored_evidence_consistent',
    evidence_scope: 'Application records, stored enable-time readiness status, native-shaped traces and typed tool results.',
    limitation: 'This cannot distinguish a real provider/native run from pre-shaped or directly inserted records, does not freshly probe current runtime readiness, and does not grade provider response quality.',
  });
}

async function getJson(context, route) {
  const response = await context.get(route, { failOnStatusCode: false, maxRedirects: 0 });
  refuse(response.status() >= 200 && response.status() < 300, `GET ${route} returned ${response.status()}`);
  const contentType = response.headers()['content-type'] ?? '';
  refuse(contentType.toLowerCase().includes('application/json'), `GET ${route} did not return JSON`);
  try { return await response.json(); }
  catch { throw new AcceptanceError(`GET ${route} returned invalid JSON`); }
}

async function collectEvidence(manifest, states) {
  const { request } = await import('@playwright/test');
  const contexts = {};
  try {
    for (const role of Object.keys(ROLE_CONTRACTS)) {
      contexts[role] = await request.newContext({
        baseURL: manifest.base_url,
        storageState: states[role].state,
        extraHTTPHeaders: { Accept: 'application/json' },
      });
    }
    const health = await getJson(contexts.partnerships, '/health');
    const roles = {};
    for (const role of Object.keys(ROLE_CONTRACTS)) {
      const entry = roleEntry(manifest, role);
      const session = await getJson(contexts[role], `/auth/session?ws=${encodeURIComponent(manifest.workspace_id)}`);
      const workflow = await getJson(contexts[role], `/w/${manifest.workspace_id}/partner-workflow`);
      const agent = roleAgent(workflow, role);
      const [assignment, trace] = await Promise.all([
        getJson(contexts[role], `/w/${manifest.workspace_id}/agents/${entry.agent_id}/skill-assignments/${agent.assignment_id}`),
        getJson(contexts[role], `/w/${manifest.workspace_id}/traces/${entry.run_id}`),
      ]);
      roles[role] = { session, workflow, assignment, trace };
    }
    const [handoff_result, requestEntity, documents] = await Promise.all([
      getJson(contexts.finance, `/w/${manifest.workspace_id}/partner-workflow/handoffs/${manifest.handoff_id}/result`),
      getJson(contexts.finance, `/w/${manifest.workspace_id}/requests/${manifest.request_id}`),
      getJson(contexts.finance, `/w/${manifest.workspace_id}/requests/${manifest.request_id}/documents`),
    ]);
    return { health, roles, handoff_result, request: requestEntity, documents };
  } finally {
    await Promise.all(Object.values(contexts).map((context) => context.dispose()));
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    refuse((key === '--manifest' || key === '--report') && value && !value.startsWith('--'), 'usage: native-staging-acceptance --manifest /absolute/path.json --report /absolute/report.json');
    args[key.slice(2)] = value;
  }
  refuse(Object.keys(args).length === 2 && args.manifest && args.report, 'both --manifest and --report are required');
  refuse(path.isAbsolute(args.manifest) && path.isAbsolute(args.report), 'manifest and report paths must be absolute');
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const ci = String(env.CI ?? '').trim().toLowerCase();
  refuse(!ci || ci === 'false' || ci === '0', 'native staging acceptance is an explicit operator check and is refused in CI');
  same(env.HERMES_NATIVE_STAGING_ACCEPT, 'read-only', 'HERMES_NATIVE_STAGING_ACCEPT');
  const args = parseArgs(argv);
  refuse(!existsSync(args.report), 'report path already exists; choose a new path so prior evidence is retained');
  let manifest;
  try { manifest = validateAcceptanceManifest(JSON.parse(readFileSync(args.manifest, 'utf8'))); }
  catch (error) {
    if (error instanceof AcceptanceError) throw error;
    throw new AcceptanceError('manifest is not valid JSON');
  }
  const states = Object.fromEntries(Object.keys(ROLE_CONTRACTS).map((role) => [
    role,
    loadSecureAuthState(roleEntry(manifest, role).auth_state, manifest.base_url),
  ]));
  refuse(states.partnerships.fingerprint !== states.finance.fingerprint, 'the two auth-state files carry the same authenticated session');
  const evidence = await collectEvidence(manifest, states);
  const report = verifyAcceptanceEvidence(evidence, manifest);
  writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  chmodSync(args.report, 0o600);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    const message = error instanceof AcceptanceError ? error.message : 'unexpected verifier failure';
    process.stderr.write(`REFUSED: ${message}\n`);
    process.exitCode = 1;
  });
}
