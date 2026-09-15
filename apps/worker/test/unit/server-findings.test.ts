// The two halves of the server findings that need no database.
//
//   F1  which requests are navigations, which are `fetch()` calls for data
//   F6  which `ScriptedProvider` script a development turn asked for
import { describe, expect, it } from 'vitest';
import { isNavigation } from '../../src/routes/spa.js';
import { DEV_SCRIPTS, pickDevScript } from '../../src/runs/workflow.js';

const request = (init: { method?: string; accept?: string; mode?: string }): Request =>
  new Request('https://hermes.test/w/ws/inbox', {
    method: init.method ?? 'GET',
    headers: {
      ...(init.accept ? { accept: init.accept } : {}),
      ...(init.mode ? { 'sec-fetch-mode': init.mode } : {}),
    },
  });

describe('F1 · isNavigation', () => {
  it('trusts Sec-Fetch-Mode where the browser sends it', () => {
    expect(isNavigation(request({ mode: 'navigate', accept: 'text/html' }))).toBe(true);
    // A `fetch()` that happens to accept HTML is still a fetch.
    expect(isNavigation(request({ mode: 'cors', accept: 'text/html' }))).toBe(false);
    expect(isNavigation(request({ mode: 'same-origin', accept: '*/*' }))).toBe(false);
  });

  it('falls back to Accept when there is no Fetch Metadata', () => {
    expect(isNavigation(request({ accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }))).toBe(true);
    expect(isNavigation(request({ accept: 'application/json' }))).toBe(false);
    expect(isNavigation(request({ accept: '*/*' }))).toBe(false);
    // Order decides: a client that named JSON first wants JSON.
    expect(isNavigation(request({ accept: 'application/json, text/html;q=0.1' }))).toBe(false);
    expect(isNavigation(request({ accept: 'text/html, application/json' }))).toBe(true);
  });

  it('is never true for a write', () => {
    expect(isNavigation(request({ method: 'POST', mode: 'navigate', accept: 'text/html' }))).toBe(false);
    expect(isNavigation(request({ method: 'DELETE', accept: 'text/html' }))).toBe(false);
  });

  it('is true for HEAD, which is how a link checker asks for a page', () => {
    expect(isNavigation(request({ method: 'HEAD', mode: 'navigate' }))).toBe(true);
  });
});

describe('F6 · pickDevScript', () => {
  it('takes the header first', () => {
    expect(pickDevScript('transient_5xx', 'Screen the applicant.')).toBe('transient_5xx');
    expect(pickDevScript('PARTIAL_STREAM', '')).toBe('partial_stream');
  });

  it('reads the turn text when there is no header', () => {
    expect(pickDevScript(undefined, 'Screen the applicant (partial_stream).')).toBe('partial_stream');
    expect(pickDevScript(undefined, 'please drive auth_401 now')).toBe('auth_401');
    expect(pickDevScript(undefined, 'malformed_tool')).toBe('malformed_tool');
  });

  it('answers nothing for ordinary prose, and for a name nobody scripted', () => {
    expect(pickDevScript(undefined, 'Screen the applicant.')).toBeUndefined();
    expect(pickDevScript('no_such_script', 'Screen the applicant.')).toBeUndefined();
    expect(pickDevScript(undefined, undefined)).toBeUndefined();
    // `completed` is the default, so naming it explicitly is the same as not.
    expect(pickDevScript(undefined, 'completed run please')).toBeUndefined();
  });

  it('puts the failure first and the ordinary script after it', () => {
    // The shape is what makes "a 503, then a Retry that works" one flag: the
    // first attempt takes the failure, and the Workflow ignores the flag on
    // every attempt after the first.
    expect(DEV_SCRIPTS.transient_5xx![0]!.throwAfter?.status).toBe(503);
    expect(DEV_SCRIPTS.transient_5xx!.length).toBeGreaterThan(1);
    expect(DEV_SCRIPTS.auth_401![0]!.throwAfter?.status).toBe(401);
    expect(DEV_SCRIPTS.partial_stream![0]!.events.length).toBeGreaterThan(0);
    expect(DEV_SCRIPTS.completed).toBe(DEV_SCRIPTS.completed);
  });
});
