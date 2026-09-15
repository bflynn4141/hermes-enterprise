// The five banner states, with the spec's exact copy (§5.4, §7).
//
// "Signed out" is the only blocking one, and it says where the draft went,
// because that is the question a person actually has when a session expires
// mid-sentence.
import { useAppState, useAdapter } from './store-context.js';
import { EMPTY } from '../model/constants.js';
import { Button } from './ui/primitives.js';
import { hasVerifiedKey } from './selectors.js';

export function ConnectionBanner() {
  const state = useAppState();
  const adapter = useAdapter();
  const banner = state.ui.banner;
  const keys = hasVerifiedKey(state);

  if (banner === 'signed-out') {
    return (
      <div className="banner banner-blocking" role="alert">
        <span>{EMPTY.signedOut}</span>
        <span className="grow" />
        <Button primary onClick={() => window.location.assign(adapter.auth.signInUrl(window.location.href))}>
          Sign in
        </Button>
      </div>
    );
  }
  if (banner === 'evicted') {
    return (
      <div className="banner banner-blocking" role="alert">
        <span>{EMPTY.evicted}</span>
        <span className="grow" />
        <Button primary onClick={() => void adapter.resync()}>
          Reload workspace
        </Button>
      </div>
    );
  }
  if (banner === 'redeploying') {
    return (
      <div className="banner" role="status">
        {EMPTY.redeploying}
      </div>
    );
  }
  if (banner === 'reconnecting') {
    return (
      <div className="banner" role="status">
        {EMPTY.reconnecting}
      </div>
    );
  }
  if (state.ready && keys.banner && !keys.rejected) {
    return (
      <div className="banner banner-quiet" role="status">
        {EMPTY.noKey}
      </div>
    );
  }
  if (state.ready && keys.rejected) {
    return (
      <div className="banner banner-quiet" role="status">
        {EMPTY.keyRejected(keys.rejected)}
      </div>
    );
  }
  return null;
}
