// The link Iris leaves behind when a run opened something.
//
// A run's `set_focus` used to move the app pane while "Following Iris" was on,
// and a person who had navigated anywhere else was "pinned" until they pressed
// Follow again. Now the run records where it worked and the reply offers it:
// one line, one click, and the pane moves because somebody asked it to.
import { useAppState, useDispatch } from '../store-context.js';
import { Icon } from '../ui/icons.js';
import { agentName, refLinkLabel } from '../selectors.js';
import type { SessionState } from '../../model/store.js';

export function FocusLink({ session }: { session: SessionState }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const focus = session.focus;
  // Hidden only while a different run is in progress: that run may be about
  // to open something else. Once it settles, or with no run at all, the last
  // thing Iris opened in this session is still the right offer.
  if (!focus) return null;
  if (session.run && session.focusRunId && session.run.id !== session.focusRunId) return null;
  const label = refLinkLabel(state, focus);
  if (!label) return null;
  return (
    <div className="focus-link" aria-label={`${agentName(state)} opened`}>
      <button type="button" className="suggestion" onClick={() => dispatch({ type: 'nav/app', object: focus, manual: true })}>
        <Icon name="open" size={14} /> Open {label}
      </button>
    </div>
  );
}
