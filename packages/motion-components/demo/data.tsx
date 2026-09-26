// SPDX-License-Identifier: MIT — Hermes examples for adapted Beautiful UI components.
import { useState, type ReactNode } from 'react';
import RecommendationCard from '../src/components/primitives/RecommendationCard';
import ContextCards, { PARTNER_CONTEXT, type ContextChunk } from '../src/components/primitives/ContextCards';
import DiffTable, { type DiffSelection } from '../src/components/primitives/DiffTable';
import RecordsTable, { PARTNER_RECORDS } from '../src/components/primitives/RecordsTable';
import FilterTable from '../src/components/primitives/FilterTable';
import Flowchart from '../src/components/primitives/Flowchart';
import InsightCards from '../src/components/primitives/InsightCards';
import CodeBlock from '../src/components/primitives/CodeBlock';

type DemoProps = { variant?: string };
function Variants({ values, value, onChange }: { values: string[]; value: string; onChange: (value: string) => void }) {
  return <div className="demo-variants" role="group" aria-label="Example variant">{values.map(option => <button type="button" key={option} aria-pressed={option === value} onClick={() => onChange(option)}>{option}</button>)}</div>;
}
function Receipt({ children }: { children?: ReactNode }) {
  return children ? <div role="status" className="rounded-control border border-line bg-inset px-3 py-2 text-[13px] text-ink-2">{children}</div> : null;
}

export function RecommendationDemo(_props: DemoProps) {
  const [opened, setOpened] = useState('');
  return <div className="demo-stack"><RecommendationCard labels={{ accepted: 'Opened' }} onConfirm={option => setOpened(option.key === 'none' ? 'Review note draft: ask both applicants for a checkable customer reference. No message sent.' : `${option.key === 'high' ? 'Leah' : 'Owen'} review opened. Maya still owns admission.`)} /><Receipt>{opened}</Receipt></div>;
}

export function ContextDemo({ variant }: DemoProps) {
  const [scope, setScope] = useState(variant === 'Program' ? 'Program' : 'All sources');
  const [source, setSource] = useState<ContextChunk | null>(null);
  return <div className="demo-stack"><Variants values={['All sources', 'Program']} value={scope} onChange={value => { setScope(value); setSource(null); }} /><ContextCards key={scope} chunks={scope === 'Program' ? PARTNER_CONTEXT.slice(0, 1) : PARTNER_CONTEXT} onOpenSource={setSource} />{source && <section className="rounded-control border border-line bg-inset p-3"><h3 className="text-[14px] font-medium text-ink">{source.source}</h3><p className="mt-2 text-[13px] leading-relaxed text-ink-2">{source.body}</p><button type="button" className="mt-2 text-[12px] text-accent-ink" onClick={() => setSource(null)}>Close source</button></section>}</div>;
}

export function DiffDemo(_props: DemoProps) {
  const [saved, setSaved] = useState<DiffSelection | null>(null);
  return <div className="demo-stack"><DiffTable onApply={selection => setSaved(selection)} /><Receipt>{saved && `${saved.removed.length + saved.added.length} local instruction edits saved in this preview. Partner operations v3 remains unchanged.`}</Receipt></div>;
}

export function RecordsDemo({ variant }: DemoProps) {
  const [scope, setScope] = useState(variant === 'Applicants' ? 'Applicants' : 'Program records');
  const [selection, setSelection] = useState<string[]>([]);
  const [opened, setOpened] = useState('');
  const rows = scope === 'Applicants' ? PARTNER_RECORDS.filter(row => row.tags.includes('Applicant')) : PARTNER_RECORDS;
  return <div className="demo-stack w-full"><Variants values={['Program records', 'Applicants']} value={scope} onChange={value => { setScope(value); setSelection([]); setOpened(''); }} /><RecordsTable key={scope} rows={rows} fill onSelectionChange={setSelection} onOpenRow={row => setOpened(`${row.name}: ${row.reviewGap}`)} /><Receipt>{opened || (selection.length ? `${selection.length} records selected` : '')}</Receipt></div>;
}

export function FilterDemo(_props: DemoProps) {
  const [opened, setOpened] = useState('');
  return <div className="demo-stack"><FilterTable onOpenRow={row => setOpened(`${row.task} · ${row.owner}${row.status === 'todo' ? ' reviews this item.' : row.status === 'progress' ? ' is working.' : ' completed this read.'}`)} /><Receipt>{opened}</Receipt></div>;
}

export function FlowDemo(_props: DemoProps) {
  const [inspected, setInspected] = useState('');
  return <div className="demo-stack w-full"><Flowchart onSelect={node => setInspected(node ? `${node.title}. Repeats for each new application.` : '')} onConditionsChange={values => setInspected(`Draft condition: ${values.prop1} is ${values.val1}; ${values.prop2} is ${values.val2}. Not activated.`)} /><Receipt>{inspected}</Receipt></div>;
}

export function InsightsDemo({ variant }: DemoProps) {
  const [opened, setOpened] = useState('');
  const initial = variant === 'Queue' ? 1 : variant === 'Mix' ? 2 : 0;
  return <div className="demo-stack"><InsightCards initialPage={initial} onAction={page => setOpened(page.key === 'compare' ? 'Evidence gaps: customer impact remains unverified in both current applications.' : page.key === 'anomaly' ? 'Queue inspection opened. The chart is illustrative; the demo Inbox still has four requests.' : 'Role comparison opened as a draft. No benefits were granted.')} /><Receipt>{opened}</Receipt></div>;
}

export function CodeDemo({ variant }: DemoProps) {
  const [view, setView] = useState(variant === 'Diff' ? 'Diff' : 'Code');
  const [copied, setCopied] = useState(false);
  return <div className="demo-stack"><Variants values={['Code', 'Diff']} value={view} onChange={value => { setView(value); setCopied(false); }} /><CodeBlock variant={view} onCopy={() => setCopied(true)} /><Receipt>{copied ? 'Partner review example copied. This is illustrative code, not a running skill.' : ''}</Receipt></div>;
}
