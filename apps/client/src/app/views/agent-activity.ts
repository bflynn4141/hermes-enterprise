import type { TraceEntity } from '@hermes/shared';
import type { AppState, SessionState } from '../../model/store.js';
import { readableTool } from '../tool-copy.js';

export type AgentActivityState = 'working' | 'waiting' | 'stopped' | 'idle';

export interface AgentActivityTool {
  name: string;
  summary: string;
  state: 'active' | 'complete' | 'failed' | 'waiting' | 'interrupted';
}

export interface AgentActivity {
  state: AgentActivityState;
  status: string;
  label: string;
  task: string;
  action: string | null;
  tool: AgentActivityTool | null;
  traceId: string | null;
  key: string;
}

const failedRun = (status: string): boolean => ['error', 'failed'].includes(status.trim().toLowerCase());

function toolFromStep(step: TraceEntity['steps'][number] | undefined, runState: AgentActivityState, runStatus: string): AgentActivityTool | null {
  if (!step?.tool_call_id) return null;
  // An orphaned/stopped run can leave a step active. Only the run can say
  // whether work is still happening; missing completion is never success.
  const state = step.state === 'failed' ? 'failed'
    : step.state === 'done' ? 'complete'
      : runState === 'working' ? 'active'
        : runState === 'waiting' ? 'waiting' : 'interrupted';
  const summary = state === 'failed' ? 'Tool failed'
    : state === 'waiting' ? 'Waiting for a response'
      : state === 'interrupted' ? (runStatus.trim().toLowerCase() === 'stopped' ? 'Stopped before completion' : 'Completion not recorded')
        : readableTool(step.label, state === 'active');
  return {
    name: step.label,
    summary,
    state,
  };
}

function latestTool(steps: TraceEntity['steps']): TraceEntity['steps'][number] | undefined {
  return [...steps].reverse().find((step) => step.state !== 'todo' && Boolean(step.tool_call_id));
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
  const toolStep = state === 'working' && current?.tool_call_id && current.state === 'active' ? current : latestTool(run?.steps ?? []);
  const tool = toolFromStep(toolStep, state, run?.status ?? session.status);
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
    action: tool ? null : state === 'working' ? (current?.label || 'Preparing a response') : state === 'waiting' ? 'Waiting for your input' : failedRun(run?.status ?? session.status) ? 'Run failed' : 'Run stopped',
    tool,
    traceId: run?.id ?? null,
    key: `${state}:${run?.id ?? session.id}:${current?.id ?? ''}:${current?.state ?? ''}:${toolStep?.id ?? ''}:${tool?.state ?? ''}`,
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
  const toolStep = state === 'working' && current?.tool_call_id && current.state === 'active' ? current : latestTool(trace.steps);
  const tool = toolFromStep(toolStep, state, trace.status);
  return {
    state,
    status: state === 'working' ? 'Working now' : state === 'waiting' ? 'Waiting for you' : state === 'stopped' ? 'Needs attention' : 'Idle',
    label: state === 'working' ? 'Current task' : state === 'waiting' ? 'Blocked on' : 'Last task',
    // Step labels describe execution, not the task. A completed "Thinking"
    // step must not read as current activity on an idle card.
    task: state === 'waiting' && current?.label && !current.tool_call_id ? current.label : trace.name,
    action: tool ? null : state === 'working' ? (current?.label || 'Preparing a response')
      : state === 'waiting' ? 'Waiting for your input'
        : state === 'stopped' ? (failedRun(trace.status) ? 'Run failed' : 'Run stopped')
          : trace.status.toLowerCase() === 'completed' ? 'Response completed · No tool calls' : 'No tool calls recorded',
    tool,
    traceId: trace.id,
    key: `${state}:${trace.id}:${current?.id ?? ''}:${current?.state ?? ''}:${toolStep?.id ?? ''}:${tool?.state ?? ''}`,
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
    action: null,
    tool: null,
    traceId: null,
    key: `idle:${recent?.id ?? 'none'}`,
  };
}
