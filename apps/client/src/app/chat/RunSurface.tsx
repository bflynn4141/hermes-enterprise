// The run surface: the five M3 components, driven only by server events.
//
// Each one is here because a real event fills it, and each one is switched off
// when nothing is happening. The standing rule from plan §10b is that every
// animated state is driven by a server event — so `loop`, `demo` and every
// built-in demonstration sequence is off, and `ThinkingState` is given an
// explicit `stage` rather than being allowed to run its own.
//
//   LoadingState   between `run.started` and the first `message.delta`. Its
//                  label is the active `run.step`'s own label; no duration is
//                  invented, because the server does not send one.
//   ThinkingState  the step rows. `stage` is `floor(done / total * 4)` (spec
//                  §12.6): a proportional map, never a stage the run has not
//                  reached. Steps kept from a superseded attempt are shown
//                  under "Earlier attempt" rather than discarded — the failure
//                  evidence is the reason a trace exists (spec §12.3).
//   ToolChips      one chip per `tool_call_id` seen on `run.step`.
//   StreamingText  the accumulator `message.delta` fills, then `message.final`.
//   TaskRows       the queue from `run.queue.updated`, plus the waiting and
//                  error states from `run.status`.
import { LoadingState, StreamingText, TaskRows, ThinkingState, ToolChips } from '@hermes/motion-components';
import type { Run, RunStep } from '@hermes/shared';
import { useAdapter } from '../store-context.js';
import type { SessionState } from '../../model/store.js';

/** `run.step` states the contract defines, mapped onto the library's words. */
function taskStatus(step: RunStep, run: Run): 'done' | 'running' | 'sequence' | 'failed' | 'blocked' {
  if (step.state === 'done') return 'done';
  if (step.state === 'failed') return 'failed';
  if (step.state === 'active') return run.status === 'waiting' ? 'blocked' : 'running';
  return 'sequence';
}

/** The library's `ThinkingRow`, which it does not re-export by name. */
interface ThinkingRow {
  primary: string;
  secondary?: string;
}

function thinkingRows(steps: readonly RunStep[]): ThinkingRow[] {
  return steps.map((step) => ({
    primary: step.label,
    // The step's own detail, never a summary of the model's reasoning: the
    // Reasoning variant shows tool names and sources read, nothing else.
    ...(step.detail ? { secondary: step.detail } : {}),
  }));
}

/**
 * The stage a controlled `ThinkingState` should show.
 *
 * Proportional, and floored, so a five-step run and a two-step run both end at
 * the last stage and neither reports a stage it has not reached.
 */
export function stageFor(steps: readonly RunStep[]): number {
  if (steps.length === 0) return 0;
  const done = steps.filter((step) => step.state === 'done').length;
  return Math.min(4, Math.floor((done / steps.length) * 4));
}

/** Steps that named a tool call, in the order the run reported them. */
function toolSteps(steps: readonly RunStep[]) {
  return steps
    .filter((step) => Boolean(step.tool_call_id))
    .map((step) => ({
      icon: step.state === 'done' ? 'check' : step.state === 'failed' ? 'alert' : 'play',
      label: step.label,
      chip: step.state === 'done' ? 'Done' : step.state === 'failed' ? 'Failed' : 'Running',
      mono: false,
      detailMono: true,
      // The 8 KB truncation marker the engine puts on a tool result renders as
      // the chip's sub text rather than being hidden.
      detail: step.detail ? [{ text: step.detail }] : [],
    }));
}

export function RunSurface({ session }: { session: SessionState }) {
  const adapter = useAdapter();
  const run = session.run;
  if (!run) return null;

  const steps = run.steps;
  const active = steps.find((step) => step.state === 'active');
  const working = run.status === 'working';
  const streaming = Boolean(session.stream?.text);
  const tools = toolSteps(steps);

  // Steps carried over from an earlier attempt: kept, collapsed, read-only.
  const current = steps.filter((step) => (step.step_attempt ?? run.attempt) === run.attempt);
  const earlier = steps.filter((step) => (step.step_attempt ?? run.attempt) !== run.attempt);

  const queueRows = (run.queue ?? [])
    .filter((item) => item.status !== 'removed')
    .map((item) => ({
      key: item.id,
      label: item.text,
      amount: item.status === 'paused' ? 'Paused' : item.status === 'sent' ? 'Sent' : 'Queued',
      status: (item.status === 'sent' ? 'done' : item.status === 'paused' ? 'blocked' : 'sequence') as 'done' | 'blocked' | 'sequence',
      details: [{ label: 'Position', meta: String(item.position + 1) }],
    }));

  const stepRows = current.map((step) => ({
    key: step.id,
    label: step.label,
    amount: '',
    status: taskStatus(step, run),
    details: step.detail ? [{ label: 'Detail', meta: step.detail }] : [],
  }));

  const rows = [...stepRows, ...queueRows];

  return (
    <div className="run-surface hermes-ui" style={{ paddingLeft: 40 }}>
      {/* Between run.started and the first delta, and only then. */}
      {working && !streaming && (
        <LoadingState
          active
          label={active?.label ?? run.title ?? 'Working'}
          // The Context variant is the one the spec names while the agent is
          // reading a document rather than calling any other tool.
          variant={active?.id.startsWith('get_document_text') ? 'context' : 'drive'}
        />
      )}

      {current.length > 0 && (
        <ThinkingState
          stage={stageFor(current)}
          rows={thinkingRows(current)}
          {...(active ? { active: active.label } : {})}
          {...(run.status === 'completed' ? { done: run.title ?? 'Done' } : {})}
        />
      )}

      {earlier.length > 0 && (
        <details className="earlier-attempt">
          <summary>Earlier attempt</summary>
          <ThinkingState stage={4} rows={thinkingRows(earlier)} done="Superseded" />
        </details>
      )}

      {tools.length > 0 && <ToolChips steps={tools} />}

      {session.stream && (
        <StreamingText fill loop={false} content={[{ text: session.stream.text }]} />
      )}

      {rows.length > 0 && (
        <TaskRows
          rows={rows}
          labels={{
            completed: 'Done',
            failed: run.error?.message ?? 'Failed',
            blocked: run.waiting_label ?? 'Waiting',
          }}
          onRetry={(key) => {
            void key;
            void adapter.retry(session.id, run.id).catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}
