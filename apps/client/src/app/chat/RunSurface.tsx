// The run surface: the five M3 components, driven only by server events.
//
// Each one is here because a real event fills it, and each one is switched off
// when nothing is happening. The standing rule from plan §10b is that every
// animated state is driven by a server event — so `loop`, `demo` and every
// built-in demonstration sequence is off, and `ThinkingState` is given an
// explicit `stage` rather than being allowed to run its own.
//
//   LoadingState   one line while a tool is running: the tool's own label and
//                  the elapsed timer. No duration is invented, because the
//                  server does not send one.
//   ToolChips      inside the collapsed "Done · N steps" disclosure, one chip
//                  per `tool_call_id`.
//   TaskRows       the queue from `run.queue.updated` and a run parked on a
//                  question. Not a step list (decision C44).
//   IrisText       the accumulator `message.delta` fills, rendered by the same
//                  component the finished message uses (decision C41).
//
// The order on screen is activity first, answer last (decision C40); a turn
// that called no tool has no activity block at all (decision C44); and every
// library component here is handed its rows explicitly — none of them is
// allowed to fall back to the gallery's fixtures (decision C42).
import { LoadingState, TaskRows, ToolChips } from '@hermes/motion-components';
import type { Message, RunStep } from '@hermes/shared';
import { useAdapter } from '../store-context.js';
import { IrisText } from './IrisText.js';
import type { SessionState } from '../../model/store.js';

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

function progressLabel(messages: readonly Message[]): string | null {
  const text = [...messages].reverse().find((message) => message.text.trim())?.text.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  return text.length > 140 ? `${text.slice(0, 137).trimEnd()}…` : text;
}

export function RunActivity({ session, progress = [] }: { session: SessionState; progress?: readonly Message[] }) {
  const adapter = useAdapter();
  const run = session.run;
  if (!run) return null;

  const steps = run.steps;
  const working = run.status === 'working';
  const settled = run.status === 'completed' || run.status === 'stopped' || run.status === 'error';

  // Only the steps that called a tool. The engine also emits a `provider` step
  // labelled "Thinking" for every model call, and a row that says the model
  // thought is a row that says nothing: it is true of every turn, it is the
  // same words every time, and it was appearing twice per turn.
  const current = steps.filter((step) => (step.step_attempt ?? run.attempt) === run.attempt);
  const earlier = steps.filter((step) => (step.step_attempt ?? run.attempt) !== run.attempt);
  const tools = toolSteps(current);
  const earlierTools = toolSteps(earlier);
  const activeTool = current.find((step) => step.state === 'active' && step.tool_call_id);
  const answerIsStreaming = Boolean(session.stream?.text.trim());
  // `run.started` can reach the client one frame before its first provider
  // step. The run status is already authoritative, so that frame still gets
  // one thinking indicator instead of an apparently idle transcript.
  const showWorkingActivity = working && (Boolean(activeTool) || !answerIsStreaming);

  // TaskRows is for the two things a person can act on: a queued follow-up, and
  // a run parked on a question. It is not a step list.
  const queueRows = (run.queue ?? [])
    .filter((item) => item.status !== 'removed')
    .map((item) => ({
      key: item.id,
      label: item.text,
      amount: item.status === 'paused' ? 'Paused' : item.status === 'sent' ? 'Sent' : 'Queued',
      status: (item.status === 'sent' ? 'done' : item.status === 'paused' ? 'blocked' : 'sequence') as 'done' | 'blocked' | 'sequence',
      details: [{ label: 'Position', meta: String(item.position + 1) }],
    }));

  const waitingRows =
    run.status === 'waiting'
      ? current
          .filter((step) => step.state === 'active')
          .map((step) => ({
            key: step.id,
            label: step.label,
            amount: 'Waiting',
            status: 'blocked' as const,
            details: step.detail ? [{ label: 'Detail', meta: step.detail }] : [],
          }))
      : [];

  const rows = [...waitingRows, ...queueRows];
  const plural = (n: number): string => `${n} ${n === 1 ? 'step' : 'steps'}`;

  // While the run is working, one activity line bridges the quiet time before
  // text arrives. After it settles, a turn with no tool call has no activity
  // block: the answer already says everything the person needs.
  const anything = showWorkingActivity || (settled && tools.length > 0) || earlierTools.length > 0 || rows.length > 0;
  if (!anything) return null;

  return (
    <div className="run-surface hermes-ui" style={{ paddingLeft: 40 }}>
      {/* Working, and a tool is running: one line, the tool's own label, the
          library's inline loader. No grid of rows growing under the reader. */}
      {showWorkingActivity && (
        <LoadingState
          active
          label={activeTool ? `${activeTool.label}…` : progressLabel(progress) ?? 'Thinking…'}
          variant={!activeTool || activeTool.id.startsWith('get_document_text') ? 'Dots' : 'Drive'}
        />
      )}

      {/* Finished: one muted line, expandable to the tool rows. This is the
          shape Claude's collapsed activity has, and the reason it is a
          `<details>` rather than the library's `ThinkingState` is that
          `ThinkingState` insists on a step list with its own spinner, its own
          checks and a 176 px floor — for a trace that is usually one row. */}
      {settled && tools.length > 0 && (
        <details className="activity-done">
          <summary>
            Done · {plural(tools.length)}
          </summary>
          <ToolChips steps={tools} diffs={[]} diffLines={{}} />
        </details>
      )}

      {earlierTools.length > 0 && (
        <details className="activity-done">
          <summary>Earlier attempt · {plural(earlierTools.length)}</summary>
          <ToolChips steps={earlierTools} diffs={[]} diffLines={{}} />
        </details>
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

/**
 * The answer: the accumulator `message.delta` fills.
 *
 * A separate component from the activity above, and rendered in a separate
 * place, because the two belong on opposite sides of the turn's finished
 * messages (decision C40). Activity goes above them; the stream is the text
 * that has not become one yet, so it goes last.
 *
 * It renders through `IrisText`, the same component the finished message uses,
 * so `message.final` swapping one for the other changes nothing on screen. The
 * library's `StreamingText` used to draw this and no longer does (decision
 * C41): it re-animates text the server already sent, it cannot render a list or
 * a table, and its `sources`, `followUps` and action row default to the
 * gallery's fixtures — which is how a reply to "testing" came to offer "Show
 * the application evidence" and claim three sources.
 */
export function RunStream({ session }: { session: SessionState }) {
  if (!session.stream || session.stream.text.length === 0) return null;
  return (
    <div className="run-surface hermes-ui" style={{ paddingLeft: 40 }}>
      <div className="stream-text">
        <IrisText text={session.stream.text} className="lead-text" />
        {session.stream.status === 'streaming' && <span className="stream-caret" aria-hidden="true" />}
      </div>
    </div>
  );
}
