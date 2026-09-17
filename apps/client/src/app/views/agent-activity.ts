import type { TraceEntity } from '@hermes/shared';
import type { AppState, SessionState } from '../../model/store.js';

export type AgentActivityState = 'working' | 'waiting' | 'stopped' | 'idle';

export interface AgentActivityTool {
  name: string;
  summary: string;
  state: 'active' | 'complete' | 'failed';
}

export interface AgentActivity {
  state: AgentActivityState;
  status: string;
  label: string;
  task: string;
  tool: AgentActivityTool | null;
  traceId: string | null;
  key: string;
}

interface ToolWords {
  active: string;
  complete: string;
}

/**
 * A tool name is useful for auditability, but it is not useful status copy.
 * Keep both: the UI renders the exact tool beside this compact translation.
 */
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
};

function readableTool(name: string, active: boolean): string {
  const known = TOOL_WORDS[name];
  if (known) return active ? known.active : known.complete;
  const words = name.replace(/[_-]+/g, ' ').trim();
  if (!words) return active ? 'Using a tool' : 'Used a tool';
  return `${active ? 'Using' : 'Used'} ${words}`;
}

function toolFromStep(step: TraceEntity['steps'][number] | undefined): AgentActivityTool | null {
  if (!step?.tool_call_id) return null;
  const state = step.state === 'active' ? 'active' : step.state === 'failed' ? 'failed' : 'complete';
  return {
    name: step.label,
    summary: readableTool(step.label, state === 'active'),
    state,
  };
}

function latestTool(steps: TraceEntity['steps']): TraceEntity['steps'][number] | undefined {
  return [...steps].reverse().find((step) => Boolean(step.tool_call_id));
}

function liveState(session: SessionState): Exclude<AgentActivityState, 'idle'> | null {
  const status = (session.run?.status ?? session.status).trim().toLowerCase();
  if (status === 'working') return 'working';
  if (status === 'waiting' || status === 'stopping') return 'waiting';
  if (status === 'stopped' || status === 'error' || status === 'failed') return 'stopped';
  return null;
}

const LIVE_PRIORITY: Record<Exclude<AgentActivityState, 'idle'>, number> = {
  working: 3,
  waiting: 2,
  stopped: 1,
};

function liveSession(state: AppState): { session: SessionState; state: Exclude<AgentActivityState, 'idle'> } | null {
  const candidates = Object.values(state.sessions)
    .filter((session) => !session.archived && (!state.agent.id || session.agentId === state.agent.id))
    .flatMap((session) => {
      const status = liveState(session);
      return status ? [{ session, state: status }] : [];
    })
    .sort((a, b) => LIVE_PRIORITY[b.state] - LIVE_PRIORITY[a.state] || b.session.lastActivity - a.session.lastActivity);
  return candidates[0] ?? null;
}

function activeStep(session: SessionState): TraceEntity['steps'][number] | undefined {
  const steps = session.run?.steps ?? [];
  return [...steps].reverse().find((step) => step.state === 'active') ?? steps.at(-1);
}

function fromLive(session: SessionState, state: Exclude<AgentActivityState, 'idle'>): AgentActivity {
  const run = session.run;
  const current = activeStep(session);
  const tool = toolFromStep(current?.tool_call_id ? current : latestTool(run?.steps ?? []));
  const waitingOn = run?.waiting_label?.trim();
  const error = run?.error?.message?.trim();
  const task = state === 'waiting' && waitingOn
    ? waitingOn
    : state === 'stopped' && error
      ? error
      : run?.title?.trim() || session.title;
  const status = state === 'working' ? 'Working now' : state === 'waiting' ? 'Waiting for you' : 'Needs attention';
  const label = state === 'working' ? 'Current task' : state === 'waiting' ? 'Blocked on' : 'Last run';
  return {
    state,
    status,
    label,
    task,
    tool,
    traceId: run?.id ?? null,
    key: `${state}:${run?.id ?? session.id}:${current?.id ?? ''}:${current?.state ?? ''}`,
  };
}

function traceState(trace: TraceEntity): AgentActivityState {
  const status = trace.status.trim().toLowerCase();
  if (status === 'working') return 'working';
  if (status === 'waiting' || trace.needs_you || status.includes('awaiting')) return 'waiting';
  if (status === 'stopped' || status === 'error' || status === 'failed') return 'stopped';
  return 'idle';
}

function fromTrace(trace: TraceEntity): AgentActivity {
  const state = traceState(trace);
  const current = [...trace.steps].reverse().find((step) => step.state === 'active') ?? trace.steps.at(-1);
  const tool = toolFromStep(current?.tool_call_id ? current : latestTool(trace.steps));
  return {
    state,
    status: state === 'working' ? 'Working now' : state === 'waiting' ? 'Waiting for you' : state === 'stopped' ? 'Needs attention' : 'Idle',
    label: state === 'working' ? 'Current task' : state === 'waiting' ? 'Blocked on' : 'Last task',
    task: current?.label && !current.tool_call_id ? current.label : trace.name,
    tool,
    traceId: trace.id,
    key: `${state}:${trace.id}:${current?.id ?? ''}:${current?.state ?? ''}`,
  };
}

/**
 * One honest answer to “what is this agent doing?” across every session.
 * Live session state wins; otherwise the newest trace (the server sorts the
 * list newest-first) supplies recent activity. No timer manufactures work.
 */
export function agentActivity(state: AppState, traces: readonly TraceEntity[]): AgentActivity {
  const live = liveSession(state);
  if (live) return fromLive(live.session, live.state);

  const trace = traces.find((item) => !state.agent.id || item.agent_id === state.agent.id);
  if (trace) return fromTrace(trace);

  const recent = Object.values(state.sessions)
    .filter((session) => !session.archived && (!state.agent.id || session.agentId === state.agent.id))
    .sort((a, b) => b.lastActivity - a.lastActivity)[0];
  return {
    state: 'idle',
    status: 'Idle',
    label: 'Current activity',
    task: recent && recent.title !== 'New session' ? `No active work · Last activity in ${recent.title}` : 'No active work right now',
    tool: null,
    traceId: null,
    key: `idle:${recent?.id ?? 'none'}`,
  };
}
