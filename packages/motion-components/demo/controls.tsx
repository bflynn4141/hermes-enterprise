import { useState } from 'react';
import ApprovalCard, { type ApprovalQuestion } from '../src/components/primitives/ApprovalCard';
import PromptBar, { type PromptSubmission } from '../src/components/primitives/PromptBar';
import SidebarNav from '../src/components/primitives/SidebarNav';
import SearchList from '../src/components/primitives/SearchList';
import SelectionActions from '../src/components/primitives/SelectionActions';
import FineTuneCard, { type FineTuneState } from '../src/components/primitives/FineTuneCard';

const questions: ApprovalQuestion[] = [
  { q: 'How many prospects should Iris shortlist?', type: 'radio', options: ['Five prospects', 'Ten prospects', 'Twenty prospects'] },
  { q: 'What evidence should Iris check?', type: 'check', options: ['Integration experience', 'Customer reach', 'Public work'] },
  { q: 'Where should the shortlist go?', type: 'radio', options: ['My inbox', 'This session', 'A draft document'] },
];

function Options({ value, values, onChange }: { value: string; values: string[]; onChange: (value: string) => void }) {
  return <div className="flex flex-wrap gap-1 rounded-control bg-field p-1" aria-label="Component variants">{values.map((option) => <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)} className={`rounded-control px-3 py-1.5 text-[13px] transition-colors duration-150 ${value === option ? 'bg-surface text-ink shadow-btn' : 'text-ink-3 hover:text-ink'}`}>{option}</button>)}</div>;
}

export function DecisionDemo() {
  const [receipt, setReceipt] = useState<string[] | null>(null);
  return <div className="flex w-full max-w-96 flex-col items-center gap-4">
    <ApprovalCard questions={questions} labels={{ send: 'Save answers', sentMessage: 'Preferences saved' }} onReset={() => setReceipt(null)} onSubmitted={(answers, customAnswers) => {
      setReceipt(questions.flatMap((question, index) => {
        const choices = (answers[index] ?? []).map((option) => question.options[option]);
        const custom = customAnswers[index]?.trim();
        return [...choices, ...(custom ? [custom] : [])];
      }));
    }} />
    {receipt && <div role="status" aria-label="Saved preferences" className="flex max-w-80 flex-wrap gap-2">{receipt.length ? receipt.map((answer, index) => <span key={`${index}-${answer}`} className="rounded-chip border border-line bg-field px-2.5 py-1.5 text-[13px] text-ink-2">{answer}</span>) : <span className="text-[13px] text-ink-3">No preferences selected</span>}</div>}
  </div>;
}

export function PromptDemo() {
  const [variant, setVariant] = useState('Rounded');
  const [walkthrough, setWalkthrough] = useState(false);
  const [submitted, setSubmitted] = useState<PromptSubmission | null>(null);
  return <div className="flex w-full max-w-xl flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><Options value={variant} values={['Rounded', 'Pill']} onChange={setVariant} /><button type="button" aria-pressed={walkthrough} onClick={() => setWalkthrough((current) => !current)} className="rounded-control px-3 py-2 text-[13px] text-ink-2 hover:bg-hover">{walkthrough ? 'Use composer' : 'Play walkthrough'}</button></div>
    <div className="flex min-h-[410px] flex-col justify-end">
      {submitted && <div className="mb-4 rounded-card bg-field p-4 text-[14px] text-ink" role="status"><p>{submitted.text || 'Attached files'}</p>{submitted.attachments.length > 0 && <p className="mt-2 text-[12px] text-ink-3">{submitted.attachments.join(' · ')}</p>}<p className="mt-2 text-[12px] text-ink-3">{submitted.model.name} · {submitted.runtime} · Demo submitted</p></div>}
      <PromptBar key={String(walkthrough)} variant={variant} demo={walkthrough} tall={!walkthrough} placeholder="Find five potential Hermes partners…" onSend={(_text, submission) => setSubmitted(submission)} />
    </div>
  </div>;
}

export function NavigationDemo() {
  const [selection, setSelection] = useState('Screen partner applications');
  const [event, setEvent] = useState('2 applications need your decision');
  return <div className="flex w-full max-w-2xl overflow-hidden rounded-card border border-line bg-surface">
    <SidebarNav activeTitle={selection} onPick={(_id, label) => { setSelection(label); setEvent('Session opened'); }} onNewChat={() => { setSelection('New Iris session'); setEvent('Ready for your instructions'); }} onNavigate={(id) => { if (id !== 'chats') { setSelection(({ overview: 'Overview', inbox: 'Inbox', members: 'Members', skills: 'Shared skills', settings: 'Settings' } as Record<string, string>)[id] ?? id); setEvent('Workspace view selected'); } }} onWorkspaceAction={(action) => { setSelection(action); setEvent('Demo action selected'); }} />
    <div className="min-w-0 flex-1 border-l border-line p-5"><div className="mb-8 flex items-center gap-2"><img src="/assets/iris.svg" width="32" height="32" alt="" /><span className="text-[15px] text-ink">Iris</span></div><h3 className="text-[24px] text-ink">{selection}</h3><p className="mt-3 text-[13px] text-ink-3" role="status">{event}</p><div className="mt-6 flex items-center gap-2 rounded-control bg-field p-3"><span className="size-1.5 rounded-full bg-green" /><span className="text-[12px] text-ink-2">Working within Maya’s permissions</span></div></div>
  </div>;
}

export function SearchDemo() {
  const [selected, setSelected] = useState('');
  return <div className="flex w-full flex-col items-center gap-4"><SearchList onSelect={setSelected} />{selected && <p className="text-[13px] text-ink-3" role="status">Selected: {selected}</p>}</div>;
}

export function SelectionDemo() {
  const [saved, setSaved] = useState('');
  return <div className="flex w-full max-w-[460px] flex-col gap-5"><SelectionActions onKeep={() => setSaved('Draft updated. Nothing sent.')} onDiscard={() => setSaved('Original kept.')} onAction={() => setSaved('')} />{saved && <p className="text-[13px] text-ink-3" role="status">{saved}</p>}</div>;
}

export function InspectorDemo() {
  const [state, setState] = useState<FineTuneState>({ segment: 0, values: { width: 324, height: 96, radius: 12, opacity: 100 }, type: 'Context' });
  return <div className="flex w-full flex-wrap items-center justify-center gap-8">
    <FineTuneCard onChange={setState} />
    <div className="flex min-h-[180px] min-w-0 flex-1 items-center justify-center overflow-hidden p-3">
      <div style={{ width: state.values.width, minHeight: state.values.height, borderRadius: state.values.radius, opacity: state.values.opacity / 100 }} className="flex max-w-full flex-col gap-3 border border-line bg-field p-4 transition-[width,min-height,border-radius,opacity] duration-300"><div className="flex items-center gap-2"><img src="/assets/context.svg" width="24" height="24" alt="" /><span className="text-[14px] text-ink">Application evidence</span></div><div className={`gap-2 ${state.segment === 1 ? 'flex flex-col' : state.segment === 2 ? 'grid grid-cols-2' : 'flex flex-wrap'}`}>{['Integration docs', 'Public work'].map((label) => <span key={label} className="rounded-chip bg-surface px-2 py-1 text-[12px] text-ink-2">{label}</span>)}</div>{state.type !== 'Select type' && <span className="text-[12px] text-ink-3">{state.type}</span>}</div>
    </div>
  </div>;
}
