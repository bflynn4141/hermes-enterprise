interface ToolWords {
  active: string;
  complete: string;
}

/** Human wording for an exact runtime tool identifier. */
const TOOL_WORDS: Readonly<Record<string, ToolWords>> = {
  list_requests: { active: 'Checking the review queue', complete: 'Checked the review queue' },
  get_request: { active: 'Reviewing a request', complete: 'Reviewed a request' },
  get_approval_status: { active: 'Checking an approval', complete: 'Checked an approval' },
  get_document_text: { active: 'Reading a source document', complete: 'Read a source document' },
  get_workspace_context: { active: 'Reading workspace context', complete: 'Read workspace context' },
  get_history: { active: 'Reviewing recent activity', complete: 'Reviewed recent activity' },
  list_members: { active: 'Checking the team', complete: 'Checked the team' },
  fetch_url: { active: 'Reviewing an approved web source', complete: 'Reviewed an approved web source' },
  propose_request: { active: 'Preparing a review request', complete: 'Prepared a review request' },
  propose_approval: { active: 'Preparing an approval', complete: 'Prepared an approval' },
  save_review_note: { active: 'Saving a review note', complete: 'Saved a review note' },
  set_context_field: { active: 'Updating workspace context', complete: 'Updated workspace context' },
  propose_instruction: { active: 'Drafting an instruction update', complete: 'Drafted an instruction update' },
  ask_for_context: { active: 'Asking for missing context', complete: 'Asked for missing context' },
  set_focus: { active: 'Opening the relevant record', complete: 'Opened the relevant record' },
  list_partner_candidates: { active: 'Checking partner candidates', complete: 'Checked partner candidates' },
  get_partner_candidate: { active: 'Reviewing a partner candidate', complete: 'Reviewed a partner candidate' },
  web_search: { active: 'Searching the web', complete: 'Searched the web' },
  web_extract: { active: 'Reading a web page', complete: 'Read a web page' },
  terminal: { active: 'Running a command', complete: 'Ran a command' },
};

/** Keep the exact identifier visible beside this translation in audit UI. */
export function readableTool(name: string, active: boolean): string {
  const known = TOOL_WORDS[name.toLowerCase().replace(/\s+/g, '_')];
  if (known) return active ? known.active : known.complete;
  const words = name.replace(/[_-]+/g, ' ').trim();
  if (!words) return active ? 'Using a tool' : 'Used a tool';
  return `${active ? 'Using' : 'Used'} ${words}`;
}

/**
 * The run engine's error `reason` is the contract (docs/CONVENTIONS.md, Style);
 * the message beside it is provider prose. A person retrying a run needs to
 * know whether the runtime or the model provider went away, so the reason is
 * translated first and the message is only the fallback.
 */
const RUN_ERROR_SENTENCES: Readonly<Record<string, string>> = {
  hermes_unavailable: 'The Hermes runtime is unavailable. Retry to reconnect.',
  hermes_runtime_not_ready: "This agent's runtime didn't pass its safety check. If retrying doesn't help, an admin needs to update it.",
  hermes_contract_violation: 'This Hermes runtime needs an Enterprise compatibility update before it can continue.',
  hermes_run_failed: 'The Hermes runtime could not finish this run. Retry to try again.',
  hermes_provider_unavailable: "The model provider didn't answer. Retry.",
  hermes_provider_rate_limited: "The model provider didn't answer. Retry.",
  hermes_provider_auth: 'The model provider rejected the workspace credentials. Reconnect it in Settings.',
  hermes_provider_quota: 'The model provider has no quota left for this workspace.',
  hermes_provider_rejected: 'The model provider rejected this request.',
  provider_unavailable: "The model provider didn't answer. Retry.",
  provider_5xx: "The model provider didn't answer. Retry.",
  provider_rejected: 'The model provider rejected this request.',
  runtime_provider_unavailable: "The model provider didn't answer. Retry.",
  runtime_provider_rate_limited: "The model provider didn't answer. Retry.",
  runtime_provider_auth: 'The model provider rejected the workspace credentials. Reconnect it in Settings.',
  runtime_provider_quota: 'The model provider has no quota left for this workspace.',
  runtime_provider_rejected: 'The model provider rejected this request.',
};

export function runErrorSentence(error: { reason?: string; message?: string } | null | undefined): string {
  if (!error) return 'Error';
  return RUN_ERROR_SENTENCES[error.reason ?? ''] ?? error.message ?? 'Error';
}

/** Run status enums as a reader sees them; unknown values (already prose) pass through. */
const RUN_STATUS_WORDS: Readonly<Record<string, string>> = {
  working: 'Working',
  waiting: 'Needs you',
  completed: 'Completed',
  error: 'Failed',
  failed: 'Failed',
  stopped: 'Stopped',
};

export function readableRunStatus(status: string): string {
  return RUN_STATUS_WORDS[status.trim().toLowerCase()] ?? status;
}

const STEP_STATE_WORDS: Readonly<Record<string, string>> = {
  todo: 'Queued',
  active: 'In progress',
  done: 'Done',
  failed: 'Failed',
};

export function readableStepState(state: string): string {
  return STEP_STATE_WORDS[state] ?? state;
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
 * The catalog label when the workspace has one; otherwise the id's last path
 * segment with the provider prefix stripped, so `nous:anthropic/claude-sonnet-5`
 * reads as `claude-sonnet-5` rather than the whole routing key.
 */
export function readableModel(modelId: string | null | undefined, catalog: ReadonlyArray<{ model_id: string; label: string }>): string {
  if (!modelId) return 'Model not recorded';
  const known = catalog.find((row) => row.model_id === modelId)?.label;
  if (known) return known;
  const afterProvider = modelId.includes(':') ? modelId.slice(modelId.indexOf(':') + 1) : modelId;
  return afterProvider.split('/').pop() || modelId;
}

const SECTION_WORDS: Readonly<Record<string, string>> = {
  agents: 'Agent', inbox: 'Inbox', members: 'Members', admin: 'Admin', history: 'History', library: 'Library', settings: 'Settings',
};
const VIEW_WORDS: Readonly<Record<string, string>> = {
  overview: 'Overview', context: 'Context', skills: 'Skills', traces: 'Runs', trace: 'Run', permissions: 'Permissions', setup: 'Setup',
  list: 'Queue', request: 'Request', rules: 'Rules', decisions: 'Decisions', documents: 'Documents', intelligence: 'Intelligence',
};
const ENTITY_WORDS: Readonly<Record<string, string>> = {
  request: 'A request', document: 'A document', session: 'A session', agent: 'The agent', member: 'A member', file: 'A file', view: 'A screen',
};

const titleWords = (value: string): string => value.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

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
