// The composer.
//
// Rewired: the model and effort lists come from `catalog` rows, and a disabled
// row shows its `disabled_reason` rather than vanishing — a model you cannot
// pick and cannot see why is worse than one you can see is unavailable. When a
// verified provider key is known to be missing, the composer greys and says so.
// Turn context is hash-bound agent_file / library_source selections that
// captureContext can load. Local uploads go through kind: 'agent_file' (never
// turn-attachment / kind: 'file'), wait for extraction, then attach as source
// chips. Drag-drop stays off so a dropped file cannot bypass that path.
//
import { useEffect, useRef, useState } from 'react';
import { ADMIN, type AttachmentDetail } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useNav } from '../store-context.js';
import { Glass, Icon } from '../ui/icons.js';
import { Button, Chip, IrisMark, MenuItem, Popover } from '../ui/primitives.js';
import { MODES, EMPTY } from '../../model/constants.js';
import { agentName, catalogRows, hasVerifiedKey, LIST_KEYS } from '../selectors.js';
import { FOCUS_COMPOSER, takeComposerFocus } from '../panel.js';
import { sourceUploadError } from '../views/source-upload-error.js';
import { ModelMenu, modelRouteLabel } from './ModelMenu.js';
import { refusalFor, type Refusal } from './refusal.js';
import { AgentFileExtractionError, waitForAgentFileReady } from './wait-agent-file-ready.js';
import type { SessionState } from '../../model/store.js';

const COMPOSER_MAX_HEIGHT = 132;

export function Composer({ session }: { session: SessionState }) {
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const nav = useNav();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [sendMode, setSendMode] = useState<'guide' | 'queue'>('guide');
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
  // turnAttachments gates source chips: pick stored agent_file / library_source
  // rows, or upload a local file as agent_file then attach once extraction is ready.
  const attachmentsAvailable = state.capabilities.turnAttachments;

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
          {approvalWaiting && <Button primary onClick={() => nav({ section: 'agents', view: 'permissions' })}>Review action</Button>}
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

      <div className="composer" data-blocked={blocked}>
        {session.settingsPending && <div className="composer-refusal" role="status">Saving model choice…</div>}
        {session.settingsError && <div className="composer-refusal" role="alert">{session.settingsError}</div>}
        {session.hydrationError && <div className="composer-refusal" role="alert">{session.hydrationError}</div>}
        {refusal && (
          <div className="composer-refusal" role="alert">
            <Glass name="trace" size={18} />
            <span className="grow">{refusal.text}</span>
            {refusal.action && state.user.role === 'admin' && (
              <Button small onClick={() => nav(ADMIN('Provider keys'))}>
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
            <span>{state.user.role === 'admin'
              ? (keys.rejected ? EMPTY.keyRejected(keys.rejected) : 'Connect Nous Portal in Admin to start')
              : 'Ask a workspace Admin to connect Nous Portal.'}</span>
            {state.user.role === 'admin' && <Button small onClick={() => nav(ADMIN('Provider keys'))}>
              Open Admin
            </Button>}
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
          <span
            className="text-btn composer-runtime-chip"
            aria-label={`Runs on ${session.runtime === 'local' ? 'Local' : 'Cloud'}`}
            title={session.runtime === 'local' ? 'Hermes Agent on this computer' : state.workspace.name}
          >
            <Icon name={session.runtime === 'local' ? 'device' : 'cloud'} size={16} />
            <span className="chip-label"> Runs on</span> {session.runtime === 'local' ? 'Local' : 'Cloud'}
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
 * Select or upload hash-bound agent sources. Uploads use kind: 'agent_file' and
 * only become draft chips after extraction is ready, so every chip names content
 * captureContext can load. Turn-attachment / kind: 'file' uploads are not used.
 */
function SourcePopover({ open, onClose, anchorRef, session }: { open: boolean; onClose: () => void; anchorRef: React.RefObject<HTMLElement | null>; session: SessionState }) {
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const nav = useNav();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<AttachmentDetail[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const agentId = session.agentId ?? state.agent.id;
  const canUpload = Boolean(agentId) && state.capabilities.turnAttachments && session.draft.attachments.length < 5 && !uploading;

  useEffect(() => {
    if (!open) return;
    let live = true;
    setFiles([]); setError(''); setStatus('');
    if (!agentId) {
      setLoading(false);
      setError('No agent is available to attach sources.');
      return () => { live = false; };
    }
    setLoading(true);
    void adapter.rest.listAgentFiles(state.workspace.id, agentId).then((page) => {
      if (live) setFiles(page.items);
    }).catch(() => {
      if (live) setError('Could not load sources. Close and reopen to try again.');
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [open, adapter, state.workspace.id, agentId]);

  const attachSource = (file: AttachmentDetail) => {
    if (!file.sha256 || file.extraction_status !== 'ready' || file.status !== 'ready') return;
    dispatch({
      type: 'session/attach',
      id: session.id,
      attachment: {
        id: file.id,
        label: file.name,
        icon: 'context',
        kind: 'source',
        source_kind: 'agent_file',
        sha256: file.sha256,
      },
    });
    onClose();
  };

  const uploadLocal = async (file: File) => {
    if (!agentId || !canUpload) return;
    setUploading(true); setError(''); setStatus('Uploading…');
    try {
      const uploaded = await adapter.upload(file, { kind: 'agent_file', agentId });
      setStatus('Processing source…');
      const ready = await waitForAgentFileReady(
        () => adapter.rest.getUpload(state.workspace.id, 'agent_file', uploaded.id),
      );
      adapter.invalidateList(LIST_KEYS.agentFiles);
      const page = await adapter.rest.listAgentFiles(state.workspace.id, agentId);
      setFiles(page.items);
      attachSource(ready);
    } catch (caught) {
      setStatus('');
      setError(caught instanceof AgentFileExtractionError ? caught.message : sourceUploadError(caught));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={440} label="Select sources" above align="left">
    <div className="row"><span className="p-title">Select sources</span><span className="grow" /><Button link onClick={onClose}>Close</Button></div>
    <p className="meta">Choose or upload up to five ready sources for your next message.</p>
    <input
      hidden
      ref={input}
      type="file"
      accept=".pdf,.md,.txt,application/pdf,text/markdown,text/plain"
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void uploadLocal(file);
      }}
    />
    <div className="row" style={{ gap: 8, marginBottom: 8 }}>
      <Button
        disabled={!canUpload}
        title={!agentId ? 'No agent is available' : session.draft.attachments.length >= 5 ? 'Five sources already selected' : undefined}
        onClick={() => input.current?.click()}
      >
        {uploading ? 'Uploading…' : 'Upload file'}
      </Button>
      <span className="grow" />
    </div>
    <div className="search"><Icon name="search" /><input aria-label="Search sources" placeholder="Search sources…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    {error && <p role="alert">{error}</p>}
    {status && !error && <p role="status">{status}</p>}
    {loading && <p role="status">Loading sources…</p>}
    <div className="col" style={{ maxHeight: 260, overflowY: 'auto' }}>{files.filter((file) => file.name.toLowerCase().includes(query.toLowerCase())).map((file) => {
      const already = session.draft.attachments.some((item) => item.id === file.id);
      const ready = file.extraction_status === 'ready' && file.status === 'ready' && file.sha256;
      return <button type="button" className="menu-item small" key={file.id} disabled={already || !ready || session.draft.attachments.length >= 5 || uploading} onClick={() => attachSource(file)}><Glass name="context" size={18} /><span className="mi-body"><span>{file.name}</span><span className="mi-sub">{already ? 'Selected' : ready ? 'Available to select' : file.extraction_status === 'failed' ? 'Processing failed' : 'Processing…'}</span></span></button>;
    })}</div>
    {!loading && !error && files.length === 0 && <p className="meta">No stored sources yet. Upload a PDF, Markdown, or text file.</p>}
    <Button link onClick={() => { onClose(); nav({ section: 'agents', view: 'context' }); }}>Manage sources →</Button>
  </Popover>;
}
