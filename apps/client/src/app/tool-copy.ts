import { modelName } from './copy/names.js';

interface ToolWords {
  active: string;
  complete: string;
  /** The thing it may do, for lists of allowed actions: "Suggest a reply". */
  action: string;
}

/**
 * Human wording for an exact tool identifier. Every tool the engine registers
 * (apps/worker/src/engine/tools.ts), the Hermes runtime's own read-only
 * `skill_view`, the AgentCash search the partner lane uses and the runtime's
 * web tools. A tool never renders by its id (docs/DESIGN.md).
 */
const TOOL_WORDS: Readonly<Record<string, ToolWords>> = {
  list_requests: { active: 'Checking the review queue', complete: 'Checked the review queue', action: 'Check the review queue' },
  get_request: { active: 'Reviewing a request', complete: 'Reviewed a request', action: 'Review a request' },
  get_approval_status: { active: 'Checking an approval', complete: 'Checked an approval', action: 'Check an approval' },
  get_document_text: { active: 'Reading a source document', complete: 'Read a source document', action: 'Read source documents' },
  get_workspace_context: { active: 'Reading workspace context', complete: 'Read workspace context', action: 'Read workspace context' },
  get_history: { active: 'Reviewing recent activity', complete: 'Reviewed recent activity', action: 'Review recent activity' },
  list_members: { active: 'Checking the team', complete: 'Checked the team', action: 'See who is on the team' },
  fetch_url: { active: 'Reviewing an approved web source', complete: 'Reviewed an approved web source', action: 'Read approved web pages' },
  propose_request: { active: 'Preparing a review request', complete: 'Prepared a review request', action: 'Prepare review requests' },
  propose_approval: { active: 'Preparing an approval', complete: 'Prepared an approval', action: 'Prepare approvals' },
  save_review_note: { active: 'Saving a review note', complete: 'Saved a review note', action: 'Save review notes' },
  set_context_field: { active: 'Updating workspace context', complete: 'Updated workspace context', action: 'Update workspace context' },
  propose_instruction: { active: 'Drafting an instruction update', complete: 'Drafted an instruction update', action: 'Suggest instruction updates' },
  ask_for_context: { active: 'Asking for missing context', complete: 'Asked for missing context', action: 'Ask you for missing context' },
  set_focus: { active: 'Opening the relevant record', complete: 'Opened the relevant record', action: 'Open records for you' },
  list_partner_candidates: { active: 'Checking partner candidates', complete: 'Checked partner candidates', action: 'Check partner candidates' },
  get_partner_candidate: { active: 'Reviewing a partner candidate', complete: 'Reviewed a partner candidate', action: 'Review partner candidates' },
  get_partner_handoff_result: { active: 'Checking a hand-off result', complete: 'Checked a hand-off result', action: 'Check hand-off results' },
  publish_partner_invoice_review: { active: 'Sending an invoice to Finance for review', complete: 'Sent an invoice to Finance for review', action: 'Send invoices to Finance for review' },
  suggest_reply: { active: 'Suggesting a reply', complete: 'Suggested a reply', action: 'Suggest replies' },
  suggest_handoff: { active: 'Handing off to another team', complete: 'Handed off to another team', action: 'Hand emails to another team' },
  skill_view: { active: 'Reading its skill instructions', complete: 'Read its skill instructions', action: 'Read its skill instructions' },
  mcp__agentcash__fetch: { active: 'Running a paid search', complete: 'Ran a paid search', action: 'Run paid searches' },
  web_search: { active: 'Searching the web', complete: 'Searched the web', action: 'Search the web' },
  web_extract: { active: 'Reading a web page', complete: 'Read a web page', action: 'Read web pages' },
  terminal: { active: 'Running a command', complete: 'Ran a command', action: 'Run commands' },
};

const toolWords = (name: string): ToolWords | undefined => TOOL_WORDS[name.trim().toLowerCase().replace(/\s+/g, '_')];

/** "Suggesting a reply" while it runs, "Suggested a reply" after. An unknown tool is "Using a tool". */
export function readableTool(name: string, active: boolean): string {
  const known = toolWords(name);
  if (known) return active ? known.active : known.complete;
  return active ? 'Using a tool' : 'Used a tool';
}

/** A finished step's label: a tool id becomes its words, prose stays as it is. */
export function readableDoneLabel(label: string): string {
  return toolWords(label) ? readableTool(label, false) : label;
}

/** What a tool lets the agent do, for a list of allowed actions. */
export function readableToolAction(name: string): string {
  return toolWords(name)?.action ?? 'Use another tool';
}

/** A deduplicated list of what a set of tools lets the agent do. */
export function readableToolActions(names: readonly string[]): string[] {
  return [...new Set(names.map(readableToolAction))];
}

/**
 * The run engine's error `reason` is the contract (docs/CONVENTIONS.md, Style);
 * the message beside it is provider or engine prose and is never shown. Every
 * reason the Worker writes on a run error has a sentence here, and a reason
 * this table does not know gets the generic one (docs/DESIGN.md).
 */
const RETRY = 'Retry to try again.';
const MODEL_DOWN = "The model didn't answer. Retry in a moment.";
const MODEL_BUSY = 'The model is busy right now. Try again in a minute.';
const MODEL_AUTH = 'The model connection was rejected. An Admin needs to reconnect it in Admin → Models.';
const MODEL_QUOTA = 'The model account has run out of credit. An Admin needs to add credit or choose another model.';
const MODEL_REJECTED = 'The model turned down this request. Try rewording it or choose another model.';
const MODEL_GONE = "The chosen model isn't available anymore. Pick another model and try again.";
const STOPPED_UNEXPECTEDLY = `The task stopped unexpectedly. ${RETRY}`;
export const RUN_ERROR_FALLBACK = `The task stopped before it finished. ${RETRY}`;

const RUN_ERROR_SENTENCES: Readonly<Record<string, string>> = {
  hermes_unavailable: "Hermes couldn't reach this agent. Retry in a moment.",
  hermes_runtime_not_ready: "This agent isn't ready to work yet. Retry, and if it keeps happening, ask an Admin to check the agent.",
  hermes_contract_violation: 'This agent needs an update before it can continue. Ask an Admin to update it.',
  hermes_run_failed: `The agent couldn't finish this task. ${RETRY}`,
  hermes_runtime_interrupted: 'The agent restarted before it finished. Retry the rest of the task.',
  hermes_provider_unavailable: MODEL_DOWN,
  hermes_provider_rate_limited: MODEL_BUSY,
  hermes_provider_auth: MODEL_AUTH,
  hermes_provider_quota: MODEL_QUOTA,
  hermes_provider_rejected: MODEL_REJECTED,
  provider_unavailable: MODEL_DOWN,
  provider_rate_limited: MODEL_BUSY,
  provider_5xx: MODEL_DOWN,
  provider_rejected: MODEL_REJECTED,
  rate_limited: MODEL_BUSY,
  key_invalid: MODEL_AUTH,
  unknown_model: MODEL_GONE,
  runtime_model_unavailable: MODEL_GONE,
  runtime_provider_unavailable: MODEL_DOWN,
  runtime_provider_rate_limited: MODEL_BUSY,
  runtime_provider_auth: MODEL_AUTH,
  runtime_provider_quota: MODEL_QUOTA,
  runtime_provider_rejected: MODEL_REJECTED,
  runtime_unavailable: "The agent couldn't be reached. Retry in a moment.",
  malformed_tool_json: "The model gave an answer the agent couldn't use. Retry, or choose another model.",
  tool_rejected: "The agent tried something it isn't allowed to do, so it stopped. That step didn't happen.",
  tool_error: `Something went wrong during this task. ${RETRY}`,
  step_failed: `Something went wrong during this task. ${RETRY}`,
  engine_version_changed: 'Hermes updated while this task was running. Retry to pick up where it left off.',
  engine_paused: 'Hermes is updating. Retry in a moment.',
  no_progress: `The agent stopped making progress. ${RETRY}`,
  instance_dead: STOPPED_UNEXPECTEDLY,
  instance_missing: STOPPED_UNEXPECTEDLY,
  automatic_recovery_runtime_drift: "The agent changed since this task started, so it can't pick up on its own. Retry it yourself.",
};

/** A run error as a sentence. Never the server's message (docs/DESIGN.md). */
export function runErrorSentence(error: { reason?: string | null; message?: string | null } | null | undefined): string {
  if (!error) return 'Something went wrong.';
  return RUN_ERROR_SENTENCES[error.reason ?? ''] ?? RUN_ERROR_FALLBACK;
}

/**
 * Run status enums as a reader sees them. A value that is already prose
 * ("Awaiting review") passes through; an enum this table does not know is
 * turned into words rather than shown raw.
 */
const RUN_STATUS_WORDS: Readonly<Record<string, string>> = {
  working: 'Working',
  waiting: 'Needs you',
  stopping: 'Stopping',
  queued: 'Queued',
  completed: 'Completed',
  error: 'Failed',
  failed: 'Failed',
  stopped: 'Stopped',
  idle: 'Idle',
};

const isEnum = (value: string): boolean => /^[a-z0-9]+(_[a-z0-9]+)*$/.test(value);

export function readableRunStatus(status: string): string {
  const key = status.trim().toLowerCase();
  const known = RUN_STATUS_WORDS[key];
  if (known) return known;
  return isEnum(status.trim()) ? titleWords(status.trim()) : status;
}

const STEP_STATE_WORDS: Readonly<Record<string, string>> = {
  todo: 'Queued',
  active: 'In progress',
  done: 'Done',
  failed: 'Failed',
};

export function readableStepState(state: string): string {
  return STEP_STATE_WORDS[state] ?? (isEnum(state) ? titleWords(state) : state);
}

/**
 * A run step's label is the tool identifier for a tool step and prose for
 * everything else ("Thinking", "Waiting for a human decision"), so only the
 * tool steps are translated.
 */
export function readableStep(step: { label: string; state: string; tool_call_id?: string | null }): string {
  return step.tool_call_id ? readableTool(step.label, step.state === 'active') : step.label;
}

/**
 * The engine parks a run on "Approve <tool> in Permissions". The tool id stays
 * in the waiting key for the Permissions button; the sentence gets the words.
 */
export function readableWaitingLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const approval = /^Approve (\S+) in Permissions$/.exec(label);
  return approval?.[1] ? `Waiting for your approval · ${readableTool(approval[1], true)}` : label;
}

/**
 * The catalog label when the workspace has one; otherwise the id read as a
 * name, so `nous:anthropic/claude-sonnet-5` reads as "Claude Sonnet 5" rather
 * than the routing key.
 */
export function readableModel(modelId: string | null | undefined, catalog: ReadonlyArray<{ model_id: string; label: string }>): string {
  return modelName(modelId, catalog);
}

const SECTION_WORDS: Readonly<Record<string, string>> = {
  agents: 'Agent', inbox: 'Inbox', members: 'Members', admin: 'Admin', history: 'History', library: 'Library', settings: 'Settings',
};
const VIEW_WORDS: Readonly<Record<string, string>> = {
  overview: 'Overview', context: 'Context', skills: 'Skills', traces: 'Activity', trace: 'Activity', permissions: 'Permissions', setup: 'Setup',
  list: 'Queue', request: 'Request', rules: 'Rules', decisions: 'Decisions', documents: 'Documents', intelligence: 'Intelligence',
};
const ENTITY_WORDS: Readonly<Record<string, string>> = {
  request: 'A request', document: 'A document', session: 'A session', agent: 'The agent', member: 'A member', file: 'A file', view: 'A screen',
};

function titleWords(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** "Inbox · Request", never the uuid the ref carries. */
export function readableRef(ref: { section: string; view?: string; sub?: string } | null | undefined): string | null {
  if (!ref) return null;
  const parts = [SECTION_WORDS[ref.section] ?? titleWords(ref.section)];
  if (ref.view) parts.push(VIEW_WORDS[ref.view] ?? titleWords(ref.view));
  if (ref.sub) parts.push(titleWords(ref.sub));
  return parts.join(' · ');
}

export function readableEntityType(type: string): string {
  return ENTITY_WORDS[type] ?? titleWords(type);
}
