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
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { SETTINGS } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useNav } from '../store-context.js';
import { Glass, Icon } from '../ui/icons.js';
import { Button, Chip, IrisMark, MenuItem, Popover, Tabs } from '../ui/primitives.js';
import { MODES, EMPTY } from '../../model/constants.js';
import { agentName, catalogRows, hasVerifiedKey } from '../selectors.js';
import { FOCUS_COMPOSER, takeComposerFocus } from '../panel.js';
import { ModelMenu } from './ModelMenu.js';
import { refusalFor, type Refusal } from './refusal.js';
import type { SessionState } from '../../model/store.js';

const COMPOSER_MAX_HEIGHT = 132;
const DOCUMENT_ACCEPT = '.pdf,.md,.txt,application/pdf,text/markdown,text/plain';

function isDocument(file: File): boolean {
  if (['application/pdf', 'text/markdown', 'text/plain'].includes(file.type)) return true;
  return /\.(pdf|md|txt)$/i.test(file.name);
}

function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

export function Composer({ session }: { session: SessionState }) {
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const nav = useNav();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [sendMode, setSendMode] = useState<'guide' | 'queue'>('guide');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const dragDepth = useRef(0);
  /**
   * The last refusal, shown above the field until the next keystroke.
   *
   * Local state rather than a store field because it is about this composer at
   * this moment: it is not an entity, it does not survive a reload, and a
   * refusal left over from a session you are no longer in would be a lie
   * (decision C45).
   */
  const [refusal, setRefusal] = useState<Refusal | null>(null);
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
    el.style.height = `${Math.min(COMPOSER_MAX_HEIGHT, el.scrollHeight)}px`;
  }, [text, session.id]);

  // A refusal belongs to one attempt. The next keystroke is the start of the
  // next one, and a session switch takes it away entirely.
  useEffect(() => setRefusal(null), [session.id]);

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

  /**
   * Send, guide or queue — and say so when the server refuses.
   *
   * Every one of the three used to end in `.catch(() => undefined)`, so a 400
   * with a sentence in it produced nothing at all on screen (decision C45).
   * Now the refusal is rendered, the draft comes back, and the caret goes back
   * where it was so the next thing typed is a correction rather than a retype.
   */
  const send = (): void => {
    const draft = text;
    if (!draft.trim() || blocked) return;
    setRefusal(null);
    const attempt =
      working && sendMode === 'queue'
        ? adapter.queue(session.id, draft)
        : working
          ? adapter.guide(session.id, draft)
          : adapter.send(session.id, draft);
    if (working) dispatch({ type: 'session/draft-clear', id: session.id });
    void attempt.catch((error: unknown) => {
      setRefusal(refusalFor(error));
      // `adapter.send` restores the draft itself, under whichever id the store
      // is keyed on by then; the other two clear it here, so they put it back
      // here. Setting it twice is harmless and losing it once is not.
      dispatch({ type: 'session/draft', id: session.id, text: draft });
      textarea.current?.focus();
    });
  };

  /**
   * Context picker and drag-and-drop share one upload path. A dropped file is
   * only attached after the Worker has verified the bytes, so a chip always
   * means the document is ready for Iris to read.
   */
  const uploadFiles = async (list: FileList | readonly File[]): Promise<void> => {
    const files = Array.from(list);
    const documents = files.filter(isDocument);
    const unsupported = files.length - documents.length;
    if (!documents.length) {
      setUploadError('Use PDF, Markdown, or text files.');
      return;
    }

    setUploadError(null);
    setUploading((count) => count + documents.length);
    let failed = 0;
    for (const file of documents) {
      try {
        const ready = await adapter.upload(file, { kind: 'attachment', sessionId: session.id });
        dispatch({ type: 'session/attach', id: session.id, attachment: { id: ready.id, label: ready.name, icon: 'context' } });
      } catch {
        failed += 1;
      }
    }
    setUploading((count) => Math.max(0, count - documents.length));
    if (failed) setUploadError(`${failed === 1 ? 'One document' : `${failed} documents`} couldn’t be added. Try again.`);
    else if (unsupported) setUploadError(`${unsupported === 1 ? 'One file was' : `${unsupported} files were`} skipped. Use PDF, Markdown, or text.`);
  };

  const enterDropZone = (event: DragEvent<HTMLDivElement>): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  const leaveDropZone = (event: DragEvent<HTMLDivElement>): void => {
    if (dragDepth.current === 0) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const dropDocuments = (event: DragEvent<HTMLDivElement>): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files.length) void uploadFiles(event.dataTransfer.files);
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

      <div
        className="composer"
        data-blocked={blocked}
        data-dragging={dragging}
        aria-busy={uploading > 0}
        onDragEnter={enterDropZone}
        onDragOver={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={leaveDropZone}
        onDrop={dropDocuments}
      >
        {dragging && (
          <div className="composer-drop-hint" role="status">
            <span className="composer-drop-icon" aria-hidden="true">
              <Glass name="context" size={24} />
              <Icon name="plus" size={14} />
            </span>
            <span>
              <strong>Drop documents</strong>
              <small>PDF, Markdown, or text</small>
            </span>
          </div>
        )}
        {refusal && (
          <div className="composer-refusal" role="alert">
            <Glass name="trace" size={18} />
            <span className="grow">{refusal.text}</span>
            {refusal.action && (
              <Button small onClick={() => nav(SETTINGS('Provider keys'))}>
                {refusal.action.label}
              </Button>
            )}
            <button type="button" className="text-btn" aria-label="Dismiss" onClick={() => setRefusal(null)}>
              <Icon name="close" />
            </button>
          </div>
        )}
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
        {(uploading > 0 || uploadError) && (
          <div className={`composer-upload-status${uploadError ? ' error' : ''}`} role={uploadError ? 'alert' : 'status'}>
            {uploading > 0 ? <><span className="upload-pulse" aria-hidden="true" />Adding {uploading === 1 ? 'document' : `${uploading} documents`}…</> : uploadError}
          </div>
        )}
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
            <AttachPopover open={menu === 'attach'} onClose={() => setMenu(null)} anchorRef={attachBtn} session={session} onUpload={uploadFiles} />
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
                <MenuItem icon="cloud" sub={session.runtime === 'cloud' ? state.workspace.name : 'Not configured for Iris'} checked={session.runtime === 'cloud'} disabled={session.runtime !== 'cloud'} onClick={() => setMenu(null)}>
                  Cloud
                </MenuItem>
                <MenuItem icon="device" sub={session.runtime === 'local' ? 'Hermes Agent on this computer' : 'Not configured for this workspace'} checked={session.runtime === 'local'} disabled={session.runtime !== 'local'} onClick={() => setMenu(null)}>
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
function AttachPopover({ open, onClose, anchorRef, session, onUpload }: { open: boolean; onClose: () => void; anchorRef: React.RefObject<HTMLElement | null>; session: SessionState; onUpload: (files: FileList | readonly File[]) => Promise<void> }) {
  const state = useAppState();
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
          accept={DOCUMENT_ACCEPT}
          hidden
          aria-label="Upload a file"
          onChange={(event) => {
            const files = event.target.files ? Array.from(event.target.files) : [];
            event.target.value = '';
            if (files.length) void onUpload(files).finally(onClose);
          }}
        />
      </div>
    </Popover>
  );
}
