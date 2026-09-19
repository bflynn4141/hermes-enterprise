// Confirmed facts are separate from instructions; sources are selected explicitly per turn.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentDetail, ContextNote } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useIsAdmin } from '../store-context.js';
import { Button, Dialog, EmptyState, Skeleton } from '../ui/primitives.js';
import { AgentContext, AgentHead, AgentTabsRow } from './Agent.js';
import { agentName, LIST_KEYS } from '../selectors.js';
import './agent-settings.css';

function NoteEditor({ note, onSave, onCancel }: { note: ContextNote | null; onSave: (title: string, text: string) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [text, setText] = useState(note?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className="agent-settings-editor" aria-label={note ? 'Edit note' : 'Add note'} onSubmit={(event) => {
    event.preventDefault();
    if (busy || !title.trim() || !text.trim()) return;
    setBusy(true); setError('');
    void onSave(title.trim(), text.trim()).catch((caught: unknown) => {
      setError(['stale_revision', 'context_revision_conflict'].includes((caught as { reason?: string }).reason ?? '') ? 'This note changed elsewhere. Cancel and reopen it to review the latest version.' : 'Could not save this note. Your text is still here. Try again.');
    }).finally(() => setBusy(false));
  }}>
    <h3 className="section-title">{note ? 'Edit note' : 'Add a note'}</h3>
    <label>Title<input autoFocus maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
    <label>Context<textarea maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} required /></label>
    <p className="meta">Used in future replies. This does not change a run already in progress.</p>
    {error && <p role="alert" className="agent-settings-error">{error}</p>}
    <div className="agent-settings-actions"><Button primary type="submit" disabled={busy || !title.trim() || !text.trim()}>{busy ? 'Saving…' : 'Save note'}</Button><Button disabled={busy} onClick={onCancel}>Cancel</Button></div>
  </form>;
}

export function AgentContextSettings({ field }: { field: string | null }) {
  const state = useAppState();
  // Keep the existing paused-reply destination flow intact.
  if (field === 'destination') return <AgentContext field={field} />;
  return <ContextContents key={`${state.workspace.id}:${state.agent.id}`} />;
}

function ContextContents() {
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const admin = useIsAdmin();
  const workspaceId = state.workspace.id;
  const agentId = state.agent.id;
  const [notes, setNotes] = useState<ContextNote[]>([]);
  const [files, setFiles] = useState<AttachmentDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [editor, setEditor] = useState<ContextNote | 'new' | null>(null);
  const [remove, setRemove] = useState<ContextNote | null>(null);
  const [open, setOpen] = useState<AttachmentDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (!agentId) return;
    const [notePage, filePage] = await Promise.all([adapter.rest.listContextNotes(workspaceId, agentId), adapter.rest.listAgentFiles(workspaceId, agentId)]);
    if (mounted.current) { setNotes(notePage.items); setFiles(filePage.items); setLoading(false); }
  }, [adapter, workspaceId, agentId]);
  useEffect(() => { void refresh().catch(() => { if (mounted.current) { setLoading(false); setError('Could not load context. Try again.'); } }); }, [refresh]);
  const processing = files.some((file) => file.extraction_status === 'pending');
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => { void refresh().catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [processing, refresh]);
  const closeEditor = () => { setEditor(null); addButton.current?.focus(); };
  const upload = async (file: File) => {
    if (!agentId || uploading) return;
    setUploading(true); setError(''); setStatus('');
    try {
      await adapter.upload(file, { kind: 'agent_file', agentId });
      await refresh(); adapter.invalidateList(LIST_KEYS.agentFiles);
      setStatus('Source uploaded. It will be available to select once processing finishes.');
    } catch { setError('Could not upload this source. Use a PDF, Markdown or text file up to 20 MB, and try again.'); }
    finally { setUploading(false); if (input.current) input.current.value = ''; }
  };
  const attach = (file: AttachmentDetail) => {
    if (!state.activeSessionId || !file.sha256 || file.extraction_status !== 'ready') return;
    dispatch({ type: 'session/attach', id: state.activeSessionId, attachment: { id: file.id, label: file.name, icon: 'context', kind: 'source', sha256: file.sha256 } });
    dispatch({ type: 'iris/panel', panel: 'open' });
    setStatus(`${file.name} selected for your next message. Nothing has been sent.`);
  };
  const session = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
  return <div className="scroll"><div className="app-body agent-settings">
    <AgentHead /><AgentTabsRow value="context" />
    <div className="agent-settings-heading"><div><h2 className="display-28">What {agentName(state)} knows</h2><p className="meta">Program facts and source material.</p></div>{admin && <button ref={addButton} type="button" className="btn primary" onClick={() => { setEditor('new'); setStatus(''); }}>+ Add context</button>}</div>
    {error && <div role="alert" className="agent-settings-error">{error} <Button link onClick={() => { setError(''); void refresh().catch(() => setError('Could not load context. Try again.')); }}>Reload context</Button></div>}
    <div className="agent-settings-status" role="status">{status}</div>
    {editor && <NoteEditor key={editor === 'new' ? 'new' : editor.id} note={editor === 'new' ? null : editor} onCancel={closeEditor} onSave={async (title, text) => {
      if (!agentId) return;
      try {
        const saved = editor === 'new' ? await adapter.rest.createContextNote(workspaceId, agentId, { title, text }) : await adapter.rest.updateContextNote(workspaceId, agentId, editor.id, { title, text, expected_revision: editor.revision });
        setNotes((current) => [saved, ...current.filter((note) => note.id !== saved.id)]); closeEditor(); setStatus('Note saved for future replies.');
      } catch (caught) { void refresh().catch(() => undefined); throw caught; }
    }} />}
    <section aria-label="Sources">
      <div className="agent-settings-heading"><div><h2 className="section-title">Sources</h2><p className="meta">Select sources for a conversation. Files are not included automatically.</p></div>{admin && <Button disabled={uploading} onClick={() => input.current?.click()}>{uploading ? 'Uploading…' : '+ Add source'}</Button>}</div>
      <input hidden ref={input} type="file" accept=".pdf,.md,.txt,application/pdf,text/markdown,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      {loading ? <Skeleton rows={2} /> : files.length === 0 ? <EmptyState icon="context" title="No sources yet" detail="Add a PDF, Markdown or text file up to 20 MB." /> : files.map((file) => <div className="agent-settings-row" key={file.id}>
        <div><span className="agent-settings-title">{file.name}</span><p className="meta">Added {new Date(file.created_at).toLocaleDateString()} · {file.extraction_status === 'ready' ? 'Available to select' : file.extraction_status === 'failed' ? 'Processing failed — upload a corrected copy' : 'Processing…'}</p></div>
        <div className="agent-settings-actions"><Button link onClick={() => setOpen(file)}>Open →</Button>{file.extraction_status === 'ready' && state.capabilities.turnAttachments && <Button disabled={!session || session.draft.attachments.some((item) => item.id === file.id)} onClick={() => attach(file)}>{session?.draft.attachments.some((item) => item.id === file.id) ? 'Selected' : 'Use in conversation'}</Button>}</div>
      </div>)}
    </section>
    <section aria-label="Confirmed notes"><div className="agent-settings-heading"><div><h2 className="section-title">Confirmed notes</h2><p className="meta">Used in future replies. These are facts, not permission changes.</p></div>{admin && <Button link onClick={() => setEditor('new')}>+ Add note</Button>}</div>
      {!loading && notes.length === 0 && <p className="meta">No confirmed notes yet.</p>}
      {notes.map((note) => <div className="agent-settings-row" key={note.id}><div><span className="agent-settings-title">{note.title}</span><p className="agent-settings-copy">{note.text}</p><p className="meta">Confirmed by {note.author_name ?? 'a workspace admin'} · Revision {note.revision}</p></div>{admin && <div className="agent-settings-actions"><Button link onClick={() => setEditor(note)}>Edit →</Button><Button link onClick={() => setRemove(note)}>Remove</Button></div>}</div>)}
    </section>
    {!admin && <p className="meta">Read-only. An admin can add or change context.</p>}
    <Dialog open={!!remove} title="Remove this note?" onClose={() => { if (!busy) setRemove(null); }} actions={<><Button disabled={busy} onClick={() => setRemove(null)}>Cancel</Button><Button disabled={busy} onClick={() => {
      if (!remove || !agentId) return;
      setBusy(true);
      void adapter.rest.deleteContextNote(workspaceId, agentId, remove.id, remove.revision).then(() => { setNotes((current) => current.filter((note) => note.id !== remove.id)); setRemove(null); setStatus('Note removed from future replies.'); }).catch(() => { setError('Could not remove this note. It may have changed elsewhere.'); setRemove(null); void refresh().catch(() => undefined); }).finally(() => setBusy(false));
    }}>Remove note</Button></>}><p>This removes “{remove?.title}” from future replies. Existing conversations and active runs keep their original context.</p></Dialog>
    <Dialog open={!!open} title={open?.name ?? 'Source'} onClose={() => setOpen(null)} actions={<><Button onClick={() => setOpen(null)}>Close</Button>{admin && <Button disabled={busy} onClick={() => {
      if (!open) return; setBusy(true);
      void adapter.rest.deleteUpload(workspaceId, 'agent_file', open.id).then(() => { setFiles((current) => current.filter((file) => file.id !== open.id)); setOpen(null); adapter.invalidateList(LIST_KEYS.agentFiles); setStatus('Source removed. Existing run snapshots are unchanged.'); }).catch(() => setError('Could not remove source. Try again.')).finally(() => setBusy(false));
    }}>Remove source</Button>}</>}>
      <p className="meta">{open?.extraction_status === 'ready' ? 'Available to select in a conversation.' : open?.extraction_status === 'failed' ? 'Processing failed. Upload a corrected copy to try again.' : 'Processing this source.'}</p>
      {open?.url && <a href={open.url} target="_blank" rel="noreferrer">View original file ↗</a>}
      <p className="meta">Removing a source does not erase text already used in conversations.</p>
    </Dialog>
  </div></div>;
}
