// The composer.
//
// Rewired: the model and effort lists come from `catalog` rows, and a disabled
// row shows its `disabled_reason` rather than vanishing — a model you cannot
// pick and cannot see why is worse than one you can see is unavailable. With no
// verified provider key the whole composer greys and says so. Attach opens the
// presign flow (POST /attachments → PUT to R2 → POST /complete) and the file
// arrives as a chip whose extraction status is updated by `entity.updated`.
//
// TODO(plan §10b, M4): the chip row becomes `PromptBar`, with Guide / After
// this as its segmented control and `demo={false}`.
import { useEffect, useRef, useState } from 'react';
import { SETTINGS } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useNav } from '../store-context.js';
import { Glass, Icon } from '../ui/icons.js';
import { Button, Chip, IrisMark, MenuItem, Popover, Tabs } from '../ui/primitives.js';
import { MODES, EMPTY } from '../../model/constants.js';
import { agentName, catalogRows, hasVerifiedKey } from '../selectors.js';
import { FOCUS_COMPOSER, takeComposerFocus } from '../panel.js';
import { ModelMenu } from './ModelMenu.js';
import type { SessionState } from '../../model/store.js';

export function Composer({ session }: { session: SessionState }) {
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const nav = useNav();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [sendMode, setSendMode] = useState<'guide' | 'queue'>('guide');
  const modeBtn = useRef<HTMLButtonElement>(null);
  const modelBtn = useRef<HTMLButtonElement>(null);
  const runtimeBtn = useRef<HTMLButtonElement>(null);
  const attachBtn = useRef<HTMLButtonElement>(null);

  const run = session.run;
  const working = run?.status === 'working';
  const text = session.draft.text;
  const keys = hasVerifiedKey(state);
  const blocked = !keys.any;
  const agent = agentName(state);
  const catalog = catalogRows(state);
  const model = catalog.find((row) => row.model_id === session.model) ?? catalog[0];
  const mode = MODES.find((m) => m.id === session.mode) ?? MODES[0];

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(208, el.scrollHeight)}px`;
  }, [text, session.id]);

  // Reopening the panel — or New session, which opens it and then creates one —
  // puts the cursor here. The shell asks by event rather than by ref, so nothing
  // above the composer has to know it exists; and the request is re-checked when
  // the session changes, because a New session's composer is not on screen at
  // the moment the request is made.
  //
  // The request is only *consumed* when it can be honoured: with no verified
  // provider key the textarea is disabled and cannot take focus, and burning
  // the request on an element that refuses it would mean the cursor never
  // arrives once the key rows land a moment later.
  useEffect(() => {
    const focus = (): void => {
      const el = textarea.current;
      if (!el || el.disabled) return;
      if (takeComposerFocus()) el.focus();
    };
    window.addEventListener(FOCUS_COMPOSER, focus);
    return () => window.removeEventListener(FOCUS_COMPOSER, focus);
  }, []);
  useEffect(() => {
    const el = textarea.current;
    if (!el || el.disabled) return;
    if (takeComposerFocus()) el.focus();
  }, [session.id, blocked]);

  const send = (): void => {
    if (!text.trim() || blocked) return;
    if (working && sendMode === 'queue') void adapter.queue(session.id, text).catch(() => undefined);
    else if (working) void adapter.guide(session.id, text).catch(() => undefined);
    else void adapter.send(session.id, text).catch(() => undefined);
    if (working) dispatch({ type: 'session/draft-clear', id: session.id });
  };

  const status = run && ['working', 'waiting', 'stopped', 'error'].includes(run.status) ? run : null;

  return (
    <div className="composer-wrap">
      {status && (
        <div className="status-bar" role="status">
          <IrisMark size={20} state={status.status === 'working' ? 'reading' : status.status === 'waiting' ? 'waiting' : 'stopped'} className="mark" />
          <span>
            {status.status === 'working'
              ? `${status.title ?? 'Working'}${status.steps.find((s) => s.state === 'active') ? ` · ${status.steps.find((s) => s.state === 'active')!.label}` : ''}`
              : status.status === 'waiting'
                ? `${status.waiting_label ?? 'Waiting'} · Nothing sent`
                : status.status === 'stopped'
                  ? 'Stopped · Completed work kept'
                  : `${status.error?.message ?? 'Error'} · Completed work kept`}
          </span>
          <span className="grow" />
          {status.status === 'working' && (
            <Button onClick={() => void adapter.stop(session.id).catch(() => undefined)} aria-label="Stop work">
              Stop work
            </Button>
          )}
          {(status.status === 'stopped' || status.status === 'error') && status.error?.retryable !== false && (
            <Button onClick={() => void adapter.retry(session.id, status.id).catch(() => undefined)}>
              {status.status === 'error' ? 'Retry remaining step' : 'Resume'}
            </Button>
          )}
        </div>
      )}

      <div className="composer" data-blocked={blocked}>
        {blocked && (
          <div className="composer-blocked" role="status">
            <span>{keys.rejected ? EMPTY.keyRejected(keys.rejected) : EMPTY.noKey}</span>
            <Button small onClick={() => nav(SETTINGS('Provider keys'))}>
              Open Settings
            </Button>
          </div>
        )}
        <div className="attachments">
          {session.context?.label && <Chip icon="context" onClick={() => session.context?.ref && nav(session.context.ref)}>{session.context.label}</Chip>}
          {session.draft.attachments.map((attachment) => (
            <Chip key={attachment.id} icon={attachment.icon ?? 'context'} onRemove={() => dispatch({ type: 'session/detach', id: session.id, attachmentId: attachment.id })} removeLabel={`Remove ${attachment.label}`}>
              {attachment.label}
            </Chip>
          ))}
        </div>
        <textarea
          id={`composer-${session.id}`}
          ref={textarea}
          rows={1}
          // The one input ⌘L is allowed to fire inside; `panel.ts` reads it.
          data-composer="true"
          value={text}
          disabled={blocked}
          placeholder={blocked ? EMPTY.noKey : working ? 'Guide this run or queue a follow-up…' : `Message ${agent}…`}
          aria-label={`Message ${agent}`}
          onChange={(event) => dispatch({ type: 'session/draft', id: session.id, text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="tools">
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <button ref={attachBtn} type="button" className="text-btn light" aria-label="Add context" aria-expanded={menu === 'attach'} onClick={() => setMenu(menu === 'attach' ? null : 'attach')}>
              <Icon name="plus" />
              <span className="chip-label"> Context</span>
            </button>
            <AttachPopover open={menu === 'attach'} onClose={() => setMenu(null)} anchorRef={attachBtn} session={session} />
          </span>
          <span className="spacer" />
          {working && (
            <span className="send-mode" role="radiogroup" aria-label={`How to send while ${agent} is working`}>
              <button type="button" aria-pressed={sendMode === 'guide'} onClick={() => setSendMode('guide')} title="Steer the current run">
                Guide this run
              </button>
              <button type="button" aria-pressed={sendMode === 'queue'} onClick={() => setSendMode('queue')} title="Queue a follow-up for after this run">
                After this
              </button>
            </span>
          )}
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <button ref={modeBtn} type="button" className="text-btn" aria-haspopup="menu" aria-expanded={menu === 'mode'} onClick={() => setMenu(menu === 'mode' ? null : 'mode')}>
              {mode!.label} <span aria-hidden="true">⌄</span>
            </button>
            <Popover open={menu === 'mode'} onClose={() => setMenu(null)} anchorRef={modeBtn} className="menu" width={270} label="Mode" above align="left">
              {MODES.map((item) => (
                <MenuItem
                  key={item.id}
                  sub={item.note}
                  checked={session.mode === item.id}
                  onClick={() => {
                    dispatch({ type: 'session/set', id: session.id, patch: { mode: item.id } });
                    void adapter.rest.patchSession(state.workspace.id, session.id, { mode: item.id }).catch(() => undefined);
                    setMenu(null);
                  }}
                >
                  {item.label}
                </MenuItem>
              ))}
              <div className="p-meta" style={{ padding: '6px 10px' }}>
                No mode grants new authority.
              </div>
            </Popover>
          </span>
          {!working && (
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              {/* Named, not just labelled by its own text: the text is the
                  current model, so "the control that changes the model" had no
                  stable name for a screen reader or a test to ask for. */}
              <button ref={modelBtn} type="button" className="text-btn" aria-haspopup="dialog" aria-label={`Model: ${model?.label ?? 'none available'}`} aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>
                {model?.label ?? EMPTY.noProvider} <span aria-hidden="true">⌄</span>
              </button>
              <ModelMenu session={session} open={menu === 'model'} onClose={() => setMenu(null)} anchorRef={modelBtn} />
            </span>
          )}
          {!working && (
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <button ref={runtimeBtn} type="button" className="text-btn" aria-haspopup="dialog" aria-expanded={menu === 'runtime'} onClick={() => setMenu(menu === 'runtime' ? null : 'runtime')}>
                <Icon name={session.runtime === 'local' ? 'device' : 'cloud'} size={16} />
                <span className="chip-label"> Runs on</span> {session.runtime === 'local' ? 'Local' : 'Cloud'} <span aria-hidden="true">⌄</span>
              </button>
              <Popover open={menu === 'runtime'} onClose={() => setMenu(null)} anchorRef={runtimeBtn} width={420} label="Runs on" above>
                <MenuItem icon="cloud" sub={state.workspace.name} checked={session.runtime === 'cloud'} onClick={() => setMenu(null)}>
                  Cloud
                </MenuItem>
                <MenuItem icon="device" sub="Not configured for this workspace" checked={session.runtime === 'local'} disabled title="Local execution is not configured" onClick={() => undefined}>
                  Local
                </MenuItem>
                <div className="p-meta" style={{ padding: '0 12px' }}>
                  Model requests use the workspace's own provider key either way; execution location does not change where the model runs.
                </div>
              </Popover>
            </span>
          )}
          <button type="button" className="send" aria-label={working ? (sendMode === 'queue' ? 'Queue follow-up' : 'Send guidance') : 'Send message'} disabled={!text.trim() || blocked} onClick={send}>
            <Icon name="up" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Attach: workspace sources, adopted skills, and an upload that goes through
 * the presign flow. Extraction status comes back as `entity.updated`, so a file
 * that is still being read says so instead of looking ready.
 */
function AttachPopover({ open, onClose, anchorRef, session }: { open: boolean; onClose: () => void; anchorRef: React.RefObject<HTMLElement | null>; session: SessionState }) {
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const files = Object.values(state.entities.agent_file).map((record) => record.data as { id: string; name: string; subtitle: string; extraction: string } | null).filter(Boolean) as { id: string; name: string; subtitle: string; extraction: string }[];
  const skills = Object.values(state.entities.skill_version).map((record) => record.data as { id: string; name: string; version: string; adopted: boolean } | null).filter(Boolean) as { id: string; name: string; version: string; adopted: boolean }[];

  const items = [
    ...files.map((file) => ({ id: `file:${file.id}`, kind: 'source', label: file.name, sub: file.extraction === 'ready' ? file.subtitle : file.extraction === 'failed' ? 'Extraction failed' : 'Being read…', icon: 'context' })),
    ...skills.map((skill) => ({ id: `skill:${skill.id}`, kind: 'skill', label: `${skill.name} · ${skill.version}`, sub: skill.adopted ? 'Skill · Already used' : 'Skill · Shared', icon: 'skill' })),
  ].filter((item) => (tab === 'all' || (tab === 'sources' ? item.kind === 'source' : item.kind === 'skill')) && item.label.toLowerCase().includes(query.toLowerCase()));

  const upload = async (list: FileList): Promise<void> => {
    for (const file of Array.from(list)) {
      try {
        // Declare, put the bytes, complete — the adapter owns all three, so
        // the direct-upload fallback and the sha/mime verdict live in one
        // place rather than in every call site that can attach a file.
        const ready = await adapter.upload(file, { kind: 'attachment', sessionId: session.id });
        dispatch({ type: 'session/attach', id: session.id, attachment: { id: ready.id, label: ready.name, icon: 'context' } });
      } catch {
        // An upload that fails leaves nothing behind; the chip never appears.
      }
    }
    onClose();
  };

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={440} label="Attach context" above align="left">
      <div className="row">
        <span className="p-title">Attach</span>
        <span className="grow" />
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <Tabs
        tabs={[
          { id: 'all', label: 'All' },
          { id: 'sources', label: 'Sources' },
          { id: 'skills', label: 'Skills' },
        ]}
        value={tab}
        onChange={setTab}
        label="Attachment type"
      />
      <div className="search">
        <Icon name="search" />
        <input placeholder="Search context and skills…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search context and skills" />
      </div>
      <div className="col" style={{ gap: 2, maxHeight: 260, overflowY: 'auto' }}>
        {items.length === 0 && <div className="p-meta" style={{ padding: 12 }}>{EMPTY.attach}</div>}
        {items.map((item) => {
          const already = session.draft.attachments.some((a) => a.id === item.id);
          return (
            <button
              type="button"
              key={item.id}
              className="menu-item small"
              role="menuitemcheckbox"
              aria-checked={already}
              disabled={already}
              onClick={() => {
                dispatch({ type: 'session/attach', id: session.id, attachment: { id: item.id, label: item.label, icon: item.icon } });
                onClose();
              }}
            >
              <Glass name={item.icon} size={18} />
              <span className="mi-body">
                <span>{item.label}</span>
                <span className="mi-sub">{item.sub}</span>
              </span>
              <span className="mi-check" aria-hidden="true">
                {already ? 'attached' : '+'}
              </span>
            </button>
          );
        })}
        <button type="button" className="menu-item small" onClick={() => fileInput.current?.click()}>
          <Icon name="plus" />
          <span className="mi-body">
            <span>Upload a file</span>
            <span className="mi-sub">pdf, md, txt · Read on the server, never sent elsewhere</span>
          </span>
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Upload a file"
          onChange={(event) => {
            if (event.target.files?.length) void upload(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
    </Popover>
  );
}
