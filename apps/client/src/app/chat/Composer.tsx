// The composer.
//
// Rewired: the model and effort lists come from `catalog` rows, and a disabled
// row shows its `disabled_reason` rather than vanishing — a model you cannot
// pick and cannot see why is worse than one you can see is unavailable. When a
// verified provider key is known to be missing, the composer greys and says so.
// The server capability contract keeps attachment controls out of the live
// composer until uploaded content can actually reach the agent runtime.
//
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { SETTINGS, type AttachmentDetail } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useNav } from '../store-context.js';
import { Glass, Icon } from '../ui/icons.js';
import { Button, Chip, IrisMark, MenuItem, Popover, Tabs } from '../ui/primitives.js';
import { MODES, EMPTY } from '../../model/constants.js';
import { agentName, catalogRows, hasVerifiedKey } from '../selectors.js';
import { FOCUS_COMPOSER, takeComposerFocus } from '../panel.js';
import { ModelMenu, modelRouteLabel } from './ModelMenu.js';
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
  const waiting = run?.status === 'waiting';
  const active = working || waiting;
  const admitting = Boolean(session.pendingTurn && !session.pendingTurn.runId);
  const approvalWaiting = waiting && run.waiting_for?.startsWith('operation_approval:');
  const contextKey = waiting && !approvalWaiting ? run.waiting_for : null;
  const text = session.draft.text;
  const keys = hasVerifiedKey(state);
  const blocked = !keys.any;
  const agent = agentName(state);
  const catalog = catalogRows(state);
  const model = catalog.find((row) => row.model_id === session.model) ?? catalog[0];
  const modelRoute = model ? modelRouteLabel(model) : null;
  const mode = MODES.find((m) => m.id === session.mode) ?? MODES[0];
  const attachmentsAvailable = state.capabilities.turnAttachments;
  // Only hash-bound stored sources have a runtime contract. Direct uploads
  // and skill chips stay hidden until those paths can actually be consumed.
  const directUploadsAvailable = false;

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
  }, [session.id, blocked, admitting]);

  /**
   * Send, guide, queue or answer context — and say so when the server refuses.
   *
   * Every one of the three used to end in `.catch(() => undefined)`, so a 400
   * with a sentence in it produced nothing at all on screen (decision C45).
   * Now the refusal is rendered, the draft comes back, and the caret goes back
   * where it was so the next thing typed is a correction rather than a retype.
   */
  const send = (): void => {
    const draft = text;
    if (!draft.trim() || blocked || admitting) return;
    setRefusal(null);
    const attempt =
      contextKey
        ? adapter.answerContext(session.id, contextKey, draft)
        : active && sendMode === 'queue'
          ? adapter.queue(session.id, draft)
          : active
            ? adapter.guide(session.id, draft)
            : adapter.send(session.id, draft);
    if (active) dispatch({ type: 'session/draft-clear', id: session.id });
    void attempt.catch((error: unknown) => {
      setRefusal(refusalFor(error));
      // `adapter.send` restores the draft itself, under whichever id the store
      // is keyed on by then; the other actions clear it here, so they put it back
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
          {approvalWaiting && <Button onClick={() => nav({ section: 'agents', view: 'permissions' })}>Review action</Button>}
          {(status.status === 'working' || status.status === 'waiting') && !admitting && (
            <Button onClick={() => void adapter.stop(session.id).catch(() => undefined)} aria-label="Stop work">
              Stop work
            </Button>
          )}
          {(status.status === 'stopped' || status.status === 'error') && status.error?.retryable !== false && (
            <Button onClick={() => void adapter.retry(session.id, status.id).catch((error: unknown) => setRefusal(refusalFor(error)))}>
              {status.status === 'error' ? 'Retry remaining step' : 'Resume'}
            </Button>
          )}
        </div>
      )}

      <div
        className="composer"
        data-blocked={blocked}
        data-dragging={attachmentsAvailable && dragging}
        aria-busy={attachmentsAvailable && uploading > 0}
        onDragEnter={directUploadsAvailable ? enterDropZone : undefined}
        onDragOver={(event) => {
          if (!directUploadsAvailable) return;
          if (!carriesFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={directUploadsAvailable ? leaveDropZone : undefined}
        onDrop={directUploadsAvailable ? dropDocuments : undefined}
      >
        {attachmentsAvailable && dragging && (
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
        {session.settingsPending && <div className="composer-refusal" role="status">Saving model choice…</div>}
        {session.settingsError && <div className="composer-refusal" role="alert">{session.settingsError}</div>}
        {session.hydrationError && <div className="composer-refusal" role="alert">{session.hydrationError}</div>}
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
        {active && !contextKey && (
          <span className="send-mode" role="radiogroup" aria-label={`How ${agent} handles your next message`}>
            <button type="button" aria-pressed={sendMode === 'guide'} onClick={() => setSendMode('guide')} title="Steer the current run">
              Steer
            </button>
            <button type="button" aria-pressed={sendMode === 'queue'} onClick={() => setSendMode('queue')} title="Queue a follow-up for after this run">
              Queue
            </button>
          </span>
        )}
        <div className="attachments">
          {session.context?.label && <Chip icon="context" onClick={() => session.context?.ref && nav(session.context.ref)}>{session.context.label}</Chip>}
          {attachmentsAvailable && session.draft.attachments.map((attachment) => (
            <Chip key={attachment.id} icon={attachment.icon ?? 'context'} onRemove={() => dispatch({ type: 'session/detach', id: session.id, attachmentId: attachment.id })} removeLabel={`Remove ${attachment.label}`}>
              {attachment.label}
            </Chip>
          ))}
        </div>
        {attachmentsAvailable && (uploading > 0 || uploadError) && (
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
          disabled={blocked || admitting}
          placeholder={
            blocked
              ? EMPTY.noKey
              : contextKey
                ? run?.waiting_label ?? 'Answer to continue…'
                : active
                  ? sendMode === 'queue'
                    ? 'Queue a follow-up…'
                    : `Steer ${agent}…`
                  : `Message ${agent}…`
          }
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
          {attachmentsAvailable && !active && !admitting && (
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <button ref={attachBtn} type="button" className="text-btn light" aria-label="Add context" aria-expanded={menu === 'attach'} onClick={() => setMenu(menu === 'attach' ? null : 'attach')}>
                <Icon name="plus" />
                <span className="chip-label"> Context</span>
              </button>
              <SourcePopover open={menu === 'attach'} onClose={() => setMenu(null)} anchorRef={attachBtn} session={session} />
            </span>
          )}
          <span className="spacer" />
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <button ref={modeBtn} type="button" className="text-btn" aria-haspopup="menu" aria-expanded={menu === 'mode'} disabled={active} title={active ? 'Available after this run' : undefined} onClick={() => setMenu(menu === 'mode' ? null : 'mode')}>
              {mode!.label} <Icon name="chevron" size={14} className="composer-selector-chevron" />
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
          <span className="composer-model-control" style={{ position: 'relative', display: 'inline-flex' }}>
            {/* Named, not just labelled by its own text: the text is the
                current model, so "the control that changes the model" had no
                stable name for a screen reader or a test to ask for. */}
            <button ref={modelBtn} type="button" className="text-btn" aria-haspopup="dialog" aria-label={`Model: ${model?.label ?? 'none available'}${modelRoute ? ` · ${modelRoute}` : ''}`} aria-expanded={menu === 'model'} disabled={active} title={active ? 'Model for this run' : model?.model_id} onClick={() => setMenu(menu === 'model' ? null : 'model')}>
              <span className="composer-model-label">{model?.label ?? EMPTY.noProvider}</span>
              {modelRoute && <span className="composer-model-route">{modelRoute}</span>}
              <Icon name="chevron" size={14} className="composer-selector-chevron" />
            </button>
            <ModelMenu session={session} open={menu === 'model'} onClose={() => setMenu(null)} anchorRef={modelBtn} />
          </span>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <button ref={runtimeBtn} type="button" className="text-btn" aria-haspopup="dialog" aria-expanded={menu === 'runtime'} disabled={active} title={active ? 'Runtime for this run' : undefined} onClick={() => setMenu(menu === 'runtime' ? null : 'runtime')}>
              <Icon name={session.runtime === 'local' ? 'device' : 'cloud'} size={16} />
              <span className="chip-label"> Runs on</span> {session.runtime === 'local' ? 'Local' : 'Cloud'} <Icon name="chevron" size={14} className="composer-selector-chevron" />
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
          <button type="button" className="send" aria-label={contextKey ? 'Send context answer' : active ? (sendMode === 'queue' ? 'Queue follow-up' : 'Send guidance') : 'Send message'} disabled={!text.trim() || blocked || admitting} onClick={send}>
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
function SourcePopover({ open, onClose, anchorRef, session }: { open: boolean; onClose: () => void; anchorRef: React.RefObject<HTMLElement | null>; session: SessionState }) {
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const nav = useNav();
  const [files, setFiles] = useState<AttachmentDetail[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || !session.agentId) return;
    let live = true;
    setFiles([]); setLoading(true); setError('');
    void adapter.rest.listAgentFiles(state.workspace.id, session.agentId).then((page) => { if (live) setFiles(page.items); }).catch(() => { if (live) setError('Could not load sources. Close and reopen to try again.'); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open, adapter, state.workspace.id, session.agentId]);
  return <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={440} label="Select sources" above align="left">
    <div className="row"><span className="p-title">Select sources</span><span className="grow" /><Button link onClick={onClose}>Close</Button></div>
    <p className="meta">Choose up to five ready sources for your next message.</p>
    <div className="search"><Icon name="search" /><input aria-label="Search sources" placeholder="Search sources…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Loading sources…</p>}
    <div className="col" style={{ maxHeight: 260, overflowY: 'auto' }}>{files.filter((file) => file.name.toLowerCase().includes(query.toLowerCase())).map((file) => {
      const already = session.draft.attachments.some((item) => item.id === file.id);
      const ready = file.extraction_status === 'ready' && file.status === 'ready' && file.sha256;
      return <button type="button" className="menu-item small" key={file.id} disabled={already || !ready || session.draft.attachments.length >= 5} onClick={() => {
        if (!file.sha256) return;
        dispatch({ type: 'session/attach', id: session.id, attachment: { id: file.id, label: file.name, icon: 'context', kind: 'source', sha256: file.sha256 } });
        onClose();
      }}><Glass name="context" size={18} /><span className="mi-body"><span>{file.name}</span><span className="mi-sub">{already ? 'Selected' : ready ? 'Available to select' : file.extraction_status === 'failed' ? 'Processing failed' : 'Processing…'}</span></span></button>;
    })}</div>
    {!loading && !error && files.length === 0 && <p className="meta">No stored sources yet.</p>}
    <Button link onClick={() => { onClose(); nav({ section: 'agents', view: 'context' }); }}>Manage sources →</Button>
  </Popover>;
}
