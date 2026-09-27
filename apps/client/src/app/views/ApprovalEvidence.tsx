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
  const dates = [['Saved', evidence.fetched_at], ['Source last changed', evidence.source_updated_at], ['Checked', evidence.verified_at]] as const;
  return <div className="approval-stored-evidence">
    <strong>What Hermes saved</strong>
    <dl>{evidence.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
    {evidence.facts.length === 0 && <p className="meta">Nothing else was saved about this source.</p>}
    {url && <a href={url} target="_blank" rel="noreferrer">Open original source</a>}
    {dates.map(([label, value]) => value && <p className="meta" key={label}>{label} · <time dateTime={value}>{new Date(value).toLocaleString()}</time></p>)}
  </div>;
}

/** A binding's version when it is a date, in words; other version strings are internal. */
function savedOn(version: string | null | undefined): string | null {
  if (!version || !/^\d{4}-\d{2}-\d{2}T/u.test(version)) return null;
  const date = new Date(version);
  return Number.isNaN(date.valueOf()) ? null : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
    {(evidence?.note ?? item.note) && <p><strong>Note</strong><br />{evidence?.note ?? item.note}</p>}
    {binding && savedOn(binding.version) && <p className="meta">Reviewed as it was on {savedOn(binding.version)}</p>}
    {status === 'loading' && <p role="status">Loading the source…</p>}
    {status === 'unavailable' && <p className="meta">The original is no longer available.</p>}
    {status === 'error' && <p role="alert">Could not load this source. <Button small onClick={fetchEvidence}>Try again</Button></p>}
    {evidence && status === 'ready' && <StoredEvidence evidence={evidence} />}
  </details>;
}

export function ApprovalEvidence({ view, load }: { view: ApprovalView; load?: EvidenceLoader }) {
  return <details className="approval-disclosure">
    <summary>Sources <span>{view.payload.evidence.length === 0 ? 'None' : view.payload.evidence.length}</span></summary>
    <div className="approval-evidence-list">
      {view.payload.evidence.length === 0 && <p className="meta">No sources came with this request.</p>}
      {view.payload.evidence.map((item) => <EvidenceReference key={item.id} item={item} binding={view.payload.resource_bindings.find((candidate) => candidate.id === item.id)} load={load} />)}
    </div>
  </details>;
}
