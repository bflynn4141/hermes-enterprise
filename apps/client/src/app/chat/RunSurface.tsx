// The run surface: the five M3 components, driven only by server events.
//
// Each one is here because a real event fills it, and each one is switched off
// when nothing is happening. The standing rule from plan §10b is that every
// animated state is driven by a server event — so `loop`, `demo` and every
// built-in demonstration sequence is off, and `ThinkingState` is given an
// explicit `stage` rather than being allowed to run its own.
//
//   LoadingState   one line for the current server-backed phase: reasoning,
//                  a live tool, or writing. No duration is invented.
//   ToolChips      exact `tool_call_id` activity, live while the run works and
//                  inside the collapsed "Done · N steps" disclosure later.
//   TaskRows       the queue from `run.queue.updated` and a run parked on a
//                  question. Not a step list (decision C44).
//   IrisText       the accumulator `message.delta` fills, rendered by the same
//                  component the finished message uses (decision C41).
//
// The order on screen is activity first, answer last (decision C40); settled
// turns without tool work have no redundant activity block (decision C44);
// and every library component here is handed its rows explicitly — none is
// allowed to fall back to the gallery's fixtures (decision C42).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { LoadingState, TaskRows, ToolChips } from '@hermes/motion-components';
import type { Message, RunStep } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch } from '../store-context.js';
import { readableTool } from '../tool-copy.js';
import { IrisText } from './IrisText.js';
import type { SessionState } from '../../model/store.js';
import { commonPrefixLength, revealBatchSize, splitGraphemes } from './stream-reveal.js';

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
  const activeTool = [...current].reverse().find((step) => step.state === 'active' && step.tool_call_id);
  const answerIsStreaming = Boolean(session.stream?.text.trim());
  const reasoningComplete = current.some((step) => step.id === 'hermes-reasoning' && step.state === 'done');
  // `run.started` can reach the client one frame before its first provider
  // step. The run status is authoritative, and the activity stays visible as
  // the phase moves from reasoning through tools into writing.
  const showWorkingActivity = working;
  const phaseLabel = activeTool
    ? readableTool(activeTool.label, true)
    : answerIsStreaming
      ? 'Writing response'
      : progressLabel(progress) ?? (reasoningComplete ? 'Preparing response' : 'Reasoning through the request');
  const liveTools = current.filter((step) => step.tool_call_id && step.state !== 'todo');

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
        <>
          <LoadingState
            active
            label={`${phaseLabel}…`}
            variant={!activeTool || activeTool.id.startsWith('get_document_text') ? 'Dots' : 'Drive'}
          />
          {liveTools.length > 0 && (
            <div className="live-tool-list" role="list" aria-label="Tool activity">
              {liveTools.map((step) => (
                <div className="live-tool-row" data-state={step.state} role="listitem" key={step.id}>
                  <span className="live-tool-dot" aria-hidden="true" />
                  <code>{step.label}</code>
                  <span>{step.state === 'active' ? readableTool(step.label, true) : step.state === 'failed' ? 'Tool failed' : readableTool(step.label, false)}</span>
                </div>
              ))}
            </div>
          )}
        </>
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
function FluidRunStream({ session, stream }: { session: SessionState; stream: NonNullable<SessionState['stream']> }) {
  const dispatch = useDispatch();
  const appReducedMotion = useAppState().ui.reduceMotion;
  const systemReducedMotion = useReducedMotion() ?? false;
  const reducedMotion = systemReducedMotion || appReducedMotion;
  const graphemes = useMemo(() => splitGraphemes(stream.text), [stream.text]);
  const [visibleText, setVisibleText] = useState(() => (reducedMotion ? stream.text : ''));
  const final = stream.status !== 'streaming';
  const completionSent = useRef(false);

  useEffect(() => {
    if (reducedMotion) {
      setVisibleText(stream.text);
      return;
    }
    if (visibleText === stream.text) return;
    const frame = window.requestAnimationFrame(() => {
      setVisibleText((current) => {
        const currentGraphemes = splitGraphemes(current);
        const prefix = commonPrefixLength(currentGraphemes, graphemes);
        const backlog = graphemes.length - prefix;
        const count = Math.min(graphemes.length, prefix + revealBatchSize(backlog, final));
        return graphemes.slice(0, count).join('');
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [final, graphemes, reducedMotion, stream.text, visibleText]);

  const renderedText = reducedMotion ? stream.text : visibleText;
  useEffect(() => {
    if (!final || renderedText !== stream.text || completionSent.current) return;
    completionSent.current = true;
    dispatch({ type: 'stream/reveal-complete', sessionId: session.id, runId: stream.runId });
  }, [dispatch, final, renderedText, session.id, stream.runId, stream.text]);

  const showCaret = !final || renderedText !== stream.text;
  return (
    <div className="run-surface hermes-ui" style={{ paddingLeft: 40 }}>
      <div className="stream-text">
        <IrisText text={renderedText} className="lead-text" />
        {showCaret && <span className="stream-caret" aria-hidden="true" />}
      </div>
    </div>
  );
}

export function RunStream({ session }: { session: SessionState }) {
  const stream = session.stream;
  if (!stream || (stream.text.length === 0 && stream.status === 'streaming')) return null;
  return <FluidRunStream key={`${stream.runId}:${stream.turn}:${stream.stepAttempt}`} session={session} stream={stream} />;
}
