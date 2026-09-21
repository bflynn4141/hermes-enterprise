// The rail: 56 px between the navigation and the app, and the whole of what is
// left of Iris when the panel is collapsed.
//
// It is modelled on the one affordance every editor with a hideable assistant
// keeps — VS Code's activity bar, which is what "open the Command Palette and
// run 'Codex: Open Codex Sidebar'… or choose the Codex icon" is describing
// (learn.chatgpt.com/docs/codex/ide). The mark is the icon, and it is not a
// static icon: it carries the same `IrisMark` state the open header does, so a
// run that is still going is visibly still going. Cursor does the same thing
// with a smaller signal — "when a tab is awaiting your input, you'll see an
// orange dot on that tab" (cursor.com/changelog/0-48-x) — and the badge here is
// that dot with a number on it.
//
// Nothing here can start or stop a run. New session and Sessions open the panel
// and then act, because both of them produce something to read.
import { useDispatch, useAppState, useAdapter } from '../store-context.js';
import { Icon } from '../ui/icons.js';
import { IrisMark, Tip } from '../ui/primitives.js';
import { agentName } from '../selectors.js';
import { requestComposerFocus } from '../panel.js';
import { useBump } from '../fresh.js';
import type { Run } from '@hermes/shared';

/**
 * The five mark states, derived from the run and nothing else.
 *
 * Four of them are the ones the open header already uses. The fifth,
 * `comparing`, is the only one that needed a rule: it is a working run that has
 * finished at least one step — it has something to compare against. That is a
 * fact about `run.steps`, not a guess about what the model is thinking, which
 * is the bar everything animated in this client has to clear.
 */
export function railMarkState(run: Run | null): 'static' | 'reading' | 'comparing' | 'waiting' | 'stopped' {
  if (!run) return 'static';
  if (run.status === 'waiting') return 'waiting';
  if (run.status === 'stopped' || run.status === 'stopping' || run.status === 'error') return 'stopped';
  if (run.status === 'working') return run.steps.some((step) => step.state === 'done') ? 'comparing' : 'reading';
  return 'static';
}

export function IrisRail({ shortcut }: { shortcut: string }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const adapter = useAdapter();
  const agent = agentName(state);
  const session = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
  const markState = railMarkState(session?.run ?? null);
  const run = session?.run;
  const unread = state.ui.irisUnread;
  const bump = useBump(unread);
  const open = (): void => dispatch({ type: 'iris/panel', panel: 'open' });

  return (
    <aside className="iris-rail" aria-label={`${agent} panel, collapsed`} data-run-state={markState}>
      <Tip label={`Open ${agent} ${shortcut}`}>
        <button
          type="button"
          className="rail-mark"
          aria-label={`Open ${agent} ${shortcut}${unread ? `, ${unread} unread` : ''}`}
          aria-expanded={false}
          onClick={open}
        >
          <IrisMark size={28} state={markState} />
          {unread > 0 && (
            <span className="rail-badge" aria-hidden="true" data-bump={bump || undefined}>
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </Tip>
      {/* The run state in words, for a screen reader and for anybody who cannot
          tell two shades of glow apart. It is the same string the open header's
          status bar would say. */}
      <span className="sr-only" role="status">
        {run?.status === 'working'
          ? `${agent} is working`
          : run?.status === 'waiting'
            ? `${agent} is waiting for an answer`
            : run?.status === 'stopped' || run?.status === 'error'
              ? `${agent} stopped`
              : ''}
      </span>
      <span className="rail-rule" aria-hidden="true" />
      <Tip label="New session">
        <button
          type="button"
          className="rail-btn"
          aria-label="New session"
          onClick={() => {
            open();
            requestComposerFocus();
            void adapter.createSession();
          }}
        >
          <Icon name="plus" size={18} />
        </button>
      </Tip>
      <Tip label="Sessions">
        <button
          type="button"
          className="rail-btn"
          aria-label="Sessions"
          onClick={() => {
            open();
            // The popover lives in the header, which does not exist yet; the
            // header opens it when it mounts and sees the request.
            dispatch({ type: 'ui/set', patch: { pane: 'chat' } });
            window.dispatchEvent(new CustomEvent('hermes:open-sessions'));
          }}
        >
          <Icon name="history" size={18} />
        </button>
      </Tip>
    </aside>
  );
}
