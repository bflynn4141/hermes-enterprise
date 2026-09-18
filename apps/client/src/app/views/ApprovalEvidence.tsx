import { useState } from 'react';
import type { ApprovalEvidenceView, ApprovalView } from '@hermes/shared';
import { Button } from '../ui/primitives.js';

type EvidenceLoader = (id: string) => Promise<ApprovalEvidenceView>;

export function evidenceSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

export function StoredEvidence({ evidence }: { evidence: ApprovalEvidenceView }) {
  const url = evidenceSourceUrl(evidence.source_url);
  const dates = [['Fetched', evidence.fetched_at], ['Source updated', evidence.source_updated_at], ['Verified', evidence.verified_at]] as const;
  return <div className="approval-stored-evidence">
    <strong>Stored source facts</strong>
    <dl>{evidence.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
    {evidence.facts.length === 0 && <p className="meta">No source facts available.</p>}
    {url && <a href={url} target="_blank" rel="noreferrer">Open original source</a>}
    {dates.map(([label, value]) => value && <p className="meta" key={label}>{label} · <time dateTime={value}>{new Date(value).toLocaleString()}</time></p>)}
    {evidence.sha256 && <p className="meta">Source digest · {evidence.sha256}</p>}
  </div>;
}

function EvidenceReference({ item, binding, load }: {
  item: ApprovalView['payload']['evidence'][number];
  binding: ApprovalView['payload']['resource_bindings'][number] | undefined;
  load?: EvidenceLoader;
}) {
  const [evidence, setEvidence] = useState<ApprovalEvidenceView | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle');
  const fetchEvidence = (): void => {
    if (!load) { setStatus('unavailable'); return; }
    setStatus('loading');
    void load(item.id).then((result) => { setEvidence(result); setStatus('ready'); }, (error: unknown) => {
      setStatus((error as { status?: number }).status === 404 ? 'unavailable' : 'error');
    });
  };
  return <details className="approval-evidence-reference" onToggle={(event) => { if (event.currentTarget.open && status === 'idle') fetchEvidence(); }}>
    <summary>{item.label}</summary>
    {(evidence?.note ?? item.note) && <p><strong>Iris’s note</strong><br />{evidence?.note ?? item.note}</p>}
    <p className="meta">Reference: {item.ref ?? item.id} · {item.kind}</p>
    {binding && <p className="meta">{binding.version ?? 'Version unavailable'}{binding.reason ? ` · ${binding.reason}` : ''}{binding.sha256 ? ` · Bound digest ${binding.sha256}` : ' · Digest unavailable'}</p>}
    {status === 'loading' && <p role="status">Loading stored evidence…</p>}
    {status === 'unavailable' && <p className="meta">Original source content is not available for this reference.</p>}
    {status === 'error' && <p role="alert">Could not load this source. <Button small onClick={fetchEvidence}>Retry source</Button></p>}
    {evidence && status === 'ready' && <StoredEvidence evidence={evidence} />}
  </details>;
}

export function ApprovalEvidence({ view, load }: { view: ApprovalView; load?: EvidenceLoader }) {
  return <details className="approval-disclosure">
    <summary>Evidence <span>{view.payload.evidence.length} reference{view.payload.evidence.length === 1 ? '' : 's'}</span></summary>
    <div className="approval-evidence-list">
      {view.payload.evidence.length === 0 && <p className="meta">No source references were supplied with this request.</p>}
      {view.payload.evidence.map((item) => <EvidenceReference key={item.id} item={item} binding={view.payload.resource_bindings.find((candidate) => candidate.id === item.id)} load={load} />)}
    </div>
  </details>;
}
