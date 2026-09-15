// The Agents section: Overview, Context, Skills, Traces, Trace detail, Setup.
//
// Every fixture literal is gone. Traces read `run_steps`, Context reads
// `agent_files` and `agent_context_fields`, Skills reads `instruction_versions`
// and the shared skill library. What did not change is the shape of the screens
// or their copy.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ThinkingState } from '@hermes/motion-components';
import { CTX, CTX_DEST, HISTORY, INBOX, OV, REQ, SKILLS_VIEW, TRACES, type AgentFile, type ContextField, type InstructionVersion, type RequestEntity, type SkillVersion, type TraceEntity, type Ref } from '@hermes/shared';
import { useAdapter, useAppState, useEntity, useIsAdmin, useNav } from '../store-context.js';
import { Glass, KIND_ICON } from '../ui/icons.js';
import { Ack, Button, Dialog, EmptyState, Panel, Skeleton, Tabs } from '../ui/primitives.js';
import { AGENT_TABS, EMPTY } from '../../model/constants.js';
import { LIST_KEYS, agentName, requestStatusLabel, rows } from '../selectors.js';
import { useWorkspaceLists } from './lists.js';

function AgentHead({ full }: { full?: boolean }) {
  const state = useAppState();
  return (
    <div className="agent-head">
      {full && <Glass name="iris" size={32} className="mark" />}
      <div className="col" style={{ gap: 2 }}>
        <h1 className="display-32">{agentName(state)}</h1>
        {full && <div className="meta">{state.agent.email}</div>}
      </div>
      <span className="grow" />
    </div>
  );
}

function AgentTabsRow({ value }: { value: string }) {
  const nav = useNav();
  const refs: Record<string, Ref> = { overview: OV, context: CTX, skills: SKILLS_VIEW, traces: TRACES };
  return <Tabs strong tabs={AGENT_TABS} value={value} onChange={(id) => nav(refs[id] ?? OV)} label="Agent views" />;
}

export function RequestRow({ request, action, onAction }: { request: RequestEntity; action: string; onAction: () => void }) {
  const type = request.kind === 'application' ? 'Program admission' : request.kind === 'invoice' ? 'Create invoice' : 'Create agreement';
  return (
    <div className="list-row">
      <Glass name={KIND_ICON[request.kind] ?? 'context'} size={32} className="row-icon" />
      <div className="row-id">
        <span className="t">{request.subject ?? request.label}</span>
        <span className="s">{request.title ?? ''}</span>
      </div>
      <div className="row-main">
        <span className="t">{type}</span>
        <span className="s">{requestStatusLabel(request)}</span>
      </div>
      <Button onClick={onAction}>{action} →</Button>
    </div>
  );
}

export function AgentOverview() {
  const state = useAppState();
  const nav = useNav();
  const lists = useWorkspaceLists();
  const admin = useIsAdmin();
  const agent = agentName(state);
  const pending = lists.requests.filter((r) => r.status === 'pending');
  const destination = rows<ContextField>(state, LIST_KEYS.contextFields, 'context_field').find((field) => field.field === 'destination');
  const blocked = destination ? !destination.value : false;

  if (lists.loading) return <div className="scroll"><div className="app-body"><Skeleton rows={4} /></div></div>;

  return (
    <div className="scroll">
      <div className="app-body">
        <AgentHead full />
        <AgentTabsRow value="overview" />
        <Panel
          icon="loop"
          title={state.workspace.name}
          subtitle={state.agent.summary || 'Screening · Drafting · Routing'}
          right={
            <div className="col" style={{ alignItems: 'flex-end', gap: 3 }}>
              <span className="meta">Enabled</span>
              <Button link onClick={() => nav(TRACES)}>
                View traces →
              </Button>
            </div>
          }
        />
        <div className="row" style={{ height: 32 }}>
          <h2 className="section-title">{admin ? 'Needs you' : 'Assigned to you'}</h2>
          <span className="grow" />
          <Button link onClick={() => nav(INBOX)}>
            Open Inbox →
          </Button>
        </div>
        <div className="col" role="list" aria-label="Requests that need you">
          <AnimatePresence initial={false}>
            {pending.map((request) => (
              <motion.div key={request.id} role="listitem" layout initial={false} exit={{ opacity: 0, height: 0, overflow: 'hidden', transition: { duration: 0.18 } }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
                <RequestRow request={request} action="Review" onAction={() => nav(REQ(request.id))} />
              </motion.div>
            ))}
          </AnimatePresence>
          {pending.length === 0 && (
            <EmptyState
              icon="admission"
              title={EMPTY.overview(agent)}
              detail={state.counts.decisions ? `${state.counts.decisions} decisions are in History · ${state.counts.pendingGrants} access grants pending` : undefined}
              action={
                state.counts.decisions ? (
                  <Button onClick={() => nav(HISTORY())}>View History</Button>
                ) : null
              }
            />
          )}
        </div>
        {destination && (
          blocked ? (
            <Panel icon="context" title={destination.label} subtitle="Missing · A reply is paused" right={<Button onClick={() => nav(CTX_DEST)}>Add context</Button>} />
          ) : (
            <Panel icon="context" title={destination.label} subtitle={`${destination.value} · Draft ready for review · Not sent`} right={<Button onClick={() => nav(CTX)}>View draft</Button>} />
          )
        )}
      </div>
    </div>
  );
}

const validDestination = (value: string): boolean => /^#[\w.-]{2,}$|^[\w.+-]+@[\w-]+\.[\w.-]+$|^https?:\/\/\S+$/.test(value.trim());

export function DestinationForm() {
  const state = useAppState();
  const adapter = useAdapter();
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<'reply' | 'future'>('reply');
  const [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const ok = validDestination(value);
  const save = (): void => {
    if (!ok) return;
    void adapter.rest
      .setContextField(state.workspace.id, 'destination', { value: value.trim(), scope })
      .then((field) => {
        adapter.ensure('context_field', field.id);
        setSaved(true);
        setTimeout(() => setSaved(false), 1600);
      })
      .catch(() => undefined);
  };
  return (
    <>
      <h2 className="display-28">Feedback destination</h2>
      <label className="field">
        <span className="sr-only">Feedback destination</span>
        <input
          ref={input}
          placeholder="Add a channel, email or link…"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
          }}
          aria-invalid={value.length > 0 && !ok}
        />
      </label>
      <div className="row" style={{ gap: 28, padding: '10px 0' }} role="radiogroup" aria-label="Scope">
        <button type="button" role="radio" className="radio" aria-checked={scope === 'reply'} onClick={() => setScope('reply')}>
          <span className="dot" />
          For this reply
        </button>
        <button type="button" role="radio" className="radio" aria-checked={scope === 'future'} onClick={() => setScope('future')}>
          <span className="dot" />
          Future replies
        </button>
      </div>
      <Panel icon="admission" title="Review before sending" subtitle="Saved context resumes the draft only." />
      <div className="app-footer inline">
        <span className="meta">{ok ? (scope === 'future' ? 'Applies to future replies · Instructions stay unchanged' : 'For this reply only') : value ? 'Enter a #channel, email address or link' : 'Destination required'}</span>
        <span className="grow" />
        <span style={{ position: 'relative' }}>
          <Button primary disabled={!ok} onClick={save}>
            Save & resume
          </Button>
          <Ack show={saved} style={{ right: 0, top: -40 }}>
            Saved
          </Ack>
        </span>
      </div>
    </>
  );
}

export function AgentContext({ field }: { field: string | null }) {
  const state = useAppState();
  const nav = useNav();
  const admin = useIsAdmin();
  const lists = useWorkspaceLists();
  const [open, setOpen] = useState<AgentFile | null>(null);
  const files = lists.agentFiles;
  const destination = lists.contextFields.find((row) => row.field === 'destination');
  const blocked = destination ? !destination.value : false;
  const editing = field === 'destination';

  return (
    <div className="scroll">
      <div className="app-body">
        <AgentHead />
        <AgentTabsRow value="context" />
        {editing ? (
          <>
            <Panel icon="context" title="Paused reply" subtitle={blocked ? 'Blocked · Destination missing' : `Ready for review · ${destination?.value}`} />
            {blocked && admin ? <DestinationForm /> : <Panel icon="context" title={destination?.value ?? EMPTY.context} subtitle={destination?.scope === 'future' ? 'Future replies · Saved' : 'For this reply · Saved'} right={<Button onClick={() => nav(CTX)}>Done</Button>} />}
            {blocked && !admin && <p className="meta">{EMPTY.adminOnly}</p>}
          </>
        ) : (
          <>
            <Panel icon="context" title="Program sources" subtitle={`${files.length} selected files`} />
            {files.length === 0 ? (
              <EmptyState icon="context" title={EMPTY.context} detail="Add files (pdf, md, txt) to give the agent something to read." />
            ) : (
              <div className="col">
                {files.map((file) => (
                  <div className="list-row compact" key={file.id}>
                    <Glass name="context" size={22} className="row-icon" />
                    <div className="row-main">
                      <span className="t">{file.name}</span>
                      <span className="s">{file.extraction === 'ready' ? file.subtitle : file.extraction === 'failed' ? `Extraction failed${file.extraction_error ? `: ${file.extraction_error}` : ''}` : 'Being read…'}</span>
                    </div>
                    <Button link onClick={() => setOpen(file)}>
                      Open →
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <h2 className="section-title">Permissions</h2>
            <div className="stat-grid">
              <div className="stat">
                <span className="k">Read</span>
                <span className="v">Selected sources</span>
              </div>
              <div className="stat">
                <span className="k">Draft</span>
                <span className="v">Messages & documents</span>
              </div>
              <div className="stat">
                <span className="k">Human review</span>
                <span className="v">External actions</span>
              </div>
            </div>
            {destination &&
              (blocked ? (
                <Panel icon="context" title={destination.label} subtitle="Missing · A reply is paused" right={<Button onClick={() => nav(CTX_DEST)}>Add context</Button>} />
              ) : (
                <Panel icon="context" title={destination.label} subtitle={`${destination.value} · ${destination.scope === 'future' ? 'Future replies' : 'This reply'}`} />
              ))}
          </>
        )}
        <Dialog open={!!open} title={open?.name ?? ''} onClose={() => setOpen(null)} actions={<Button onClick={() => setOpen(null)}>Close</Button>}>
          <p className="meta">{open?.subtitle}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{open?.body ?? 'This file has not been extracted yet.'}</p>
        </Dialog>
      </div>
    </div>
  );
}

export function AgentSkills() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const lists = useWorkspaceLists();
  const [ack, setAck] = useState(false);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  const current = lists.instructions.find((row) => row.state === 'current');
  const proposed = lists.instructions.find((row) => row.state === 'proposed');
  const saved = lists.instructions.find((row) => row.state === 'saved');
  const status = proposed ? 'Proposed' : saved ? 'Saved' : 'Current';

  return (
    <div className="scroll">
      <div className="app-body" style={{ minHeight: '100%' }}>
        <AgentHead />
        <AgentTabsRow value="skills" />
        {lists.skills.filter((skill) => skill.adopted).map((skill) => (
          <Panel key={skill.id} icon="skill" title={`${skill.name} · ${skill.version}`} subtitle={`Shared by ${skill.shared_by}`} />
        ))}
        <div className="row">
          <h2 className="section-title">Screening instructions</h2>
          <span className="grow" />
          <span className="meta">{status}</span>
        </div>
        {current && (
          <div className="col" style={{ gap: 6, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
            <span className="meta">Current</span>
            <span>{current.text}</span>
          </div>
        )}
        {(proposed ?? saved) && (
          <div className="diff-block">
            <span className="k">{proposed ? 'Add for future reviews' : 'Added for future reviews · Saved'}</span>
            <span className="v">{(proposed ?? saved)!.text}</span>
            {(proposed ?? saved)!.provenance && <span className="k">{(proposed ?? saved)!.provenance}</span>}
          </div>
        )}
        {!proposed && !saved && admin && (
          edit ? (
            <div className="col" style={{ gap: 12 }}>
              <label className="field">
                <span className="sr-only">Proposed instruction</span>
                <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} />
              </label>
              <div className="row">
                <Button
                  primary
                  disabled={!text.trim()}
                  onClick={() => {
                    void adapter.rest.proposeInstruction(state.workspace.id, text.trim()).then((row) => adapter.ensure('instruction_version', row.id)).catch(() => undefined);
                    setEdit(false);
                  }}
                >
                  Propose change
                </Button>
                <Button onClick={() => setEdit(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="note-block">
              <span className="t">{EMPTY.skills}</span>
              <span className="s">Ask in chat, or propose one here.</span>
              <div>
                <Button small onClick={() => setEdit(true)}>
                  Propose a change
                </Button>
              </div>
            </div>
          )
        )}
        {!admin && <p className="meta">Read-only. {EMPTY.adminOnly}</p>}
        {admin && (
          <div className="app-footer inline">
            <span className="meta">Applies from the next screening · Shared skills unchanged</span>
            <span className="grow" />
            <span style={{ position: 'relative', display: 'inline-flex', gap: 12 }}>
              {proposed && (
                <Button onClick={() => void adapter.rest.discardInstruction(state.workspace.id, proposed.id).catch(() => undefined)}>Discard</Button>
              )}
              <Button
                primary
                disabled={!proposed}
                onClick={() => {
                  if (!proposed) return;
                  void adapter.rest.saveInstruction(state.workspace.id, proposed.id).then((row) => adapter.ensure('instruction_version', row.id)).catch(() => undefined);
                  setAck(true);
                  setTimeout(() => setAck(false), 1600);
                }}
              >
                Save
              </Button>
              <Ack show={ack} style={{ right: 0, top: -40 }}>
                Saved
              </Ack>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentTraces() {
  const nav = useNav();
  const lists = useWorkspaceLists();
  const [tab, setTab] = useState('all');
  const traces = useMemo(() => lists.traces.filter((trace) => (tab === 'all' ? true : tab === 'needs' ? trace.needs_you : !trace.needs_you)), [lists.traces, tab]);

  return (
    <div className="scroll">
      <div className="app-body">
        <AgentHead />
        <AgentTabsRow value="traces" />
        <div className="row">
          <h2 className="display-28">Runs</h2>
        </div>
        <Tabs
          tabs={[
            { id: 'all', label: 'All' },
            { id: 'needs', label: 'Needs you' },
            { id: 'done', label: 'Completed' },
          ]}
          value={tab}
          onChange={setTab}
          label="Run filter"
        />
        <div className="col">
          {traces.length === 0 && <EmptyState icon="trace" title={EMPTY.traces} />}
          {traces.map((trace) => (
            <div className="list-row" key={trace.id} style={{ minHeight: 100 }}>
              <Glass name="trace" size={28} className="row-icon" />
              <div className="row-id" style={{ width: 230 }}>
                <span className="t">{trace.name}</span>
                <span className="s">{trace.type}</span>
              </div>
              <div className="row-main">
                <span className="t">{trace.status}</span>
                <span className="s">{trace.sub}</span>
              </div>
              <Button link onClick={() => nav({ section: 'agents', view: 'trace', id: trace.id })}>
                Open →
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TraceDetail({ id }: { id: string | null }) {
  const record = useEntity<TraceEntity>('trace', id);
  if (record.state === 'loading') {
    return (
      <div className="scroll">
        <div className="app-body">
          <Skeleton rows={5} label="Loading the run" />
        </div>
      </div>
    );
  }
  if (record.state === 'missing' || record.state === 'unavailable' || !record.data) {
    return (
      <div className="scroll">
        <div className="app-body">
          <EmptyState icon="trace" title={record.state === 'unavailable' ? EMPTY.libraryUnavailable : EMPTY.traceMissing} />
        </div>
      </div>
    );
  }
  const trace = record.data;
  const done = trace.steps.filter((step) => step.state === 'done').length;
  // Map five stages proportionally, and always show the real labels (spec §12.6).
  const stage = trace.steps.length ? Math.floor((done / trace.steps.length) * 4) : 0;

  return (
    <div className="scroll">
      <div className="app-body">
        <AgentHead />
        <AgentTabsRow value="traces" />
        <div className="row">
          <h2 className="display-28">{trace.name} · {trace.type}</h2>
          <span className="grow" />
          <span className="meta">{trace.status}</span>
        </div>
        <div className="hermes-ui">
          <ThinkingState stage={stage} rows={trace.steps.map((step) => ({ primary: step.label, ...(step.detail ? { secondary: step.detail } : {}) }))} active={trace.status} done={`${done} of ${trace.steps.length} steps`} />
        </div>
        <Panel icon="trace" title="Allowed tools" subtitle={trace.allowed_tools.join(' · ') || 'None recorded'} />
        <p className="meta">Opening a trace never advances a run or decides anything. The trace shows sources, findings and named human decisions, not hidden reasoning.</p>
      </div>
    </div>
  );
}

/**
 * The Setup screen the onboarding stepper hands off to. Progress lives on
 * `agents.setup_step`, so leaving and returning resumes where it stopped.
 */
export function Setup({ step }: { step: string }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const lists = useWorkspaceLists();
  const tabs = [
    { id: 'identity', label: 'Identity' },
    { id: 'context', label: 'Context' },
    { id: 'permissions', label: 'Permissions' },
    { id: 'ready', label: 'Ready' },
  ];
  const goto = (next: string): void => {
    nav({ section: 'agents', view: 'setup', step: next });
    if (state.agent.id) void adapter.rest.patchAgent(state.workspace.id, state.agent.id, { setup_step: next }).catch(() => undefined);
  };
  return (
    <div className="scroll">
      <div className="app-body" style={{ minHeight: '100%' }}>
        <div className="row" style={{ height: 42 }}>
          <h1 className="display-32">Start {agentName(state)}</h1>
        </div>
        <Tabs tabs={tabs} value={step} onChange={goto} label="Setup steps" />
        {step === 'identity' && (
          <>
            <Panel icon="iris" title={agentName(state)} subtitle={state.agent.email} right={<span className="meta">Loop not started</span>} />
            <div className="row">
              <Button primary onClick={() => goto('context')}>
                Continue
              </Button>
            </div>
          </>
        )}
        {step === 'context' && (
          <>
            <Panel icon="context" title="Program sources" subtitle={`${lists.agentFiles.length} selected files`} />
            <div className="col">
              {lists.agentFiles.map((file) => (
                <div className="list-row compact" key={file.id}>
                  <Glass name="context" size={22} className="row-icon" />
                  <div className="row-main">
                    <span className="t">{file.name}</span>
                    <span className="s">{file.subtitle}</span>
                  </div>
                </div>
              ))}
              {lists.agentFiles.length === 0 && <EmptyState icon="context" title={EMPTY.context} />}
            </div>
            <div className="row">
              <Button primary onClick={() => goto('permissions')}>
                Continue
              </Button>
            </div>
          </>
        )}
        {step === 'permissions' && (
          <>
            <div className="setup-two" style={{ padding: 0, gap: 24 }}>
              <div className="col grow" style={{ gap: 8 }}>
                <h3 className="section-title">{agentName(state)} can</h3>
                {['Read the selected sources', 'Prepare reports and drafts', 'Ask for a decision'].map((title) => (
                  <div className="col" key={title} style={{ gap: 2, padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                    <span>{title}</span>
                  </div>
                ))}
              </div>
              <div className="col grow" style={{ gap: 8 }}>
                <h3 className="section-title">A human approves</h3>
                {['Admissions and benefits', 'Document creation', 'Sending, payment and signature'].map((title) => (
                  <div className="col" key={title} style={{ gap: 2, padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                    <span>{title}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="row">
              <Button primary onClick={() => goto('ready')}>
                Continue
              </Button>
            </div>
          </>
        )}
        {step === 'ready' && (
          <>
            <Panel icon="iris" title={agentName(state)} subtitle={state.agent.email} right={<span className="meta">Loop not started</span>} />
            <p style={{ fontSize: 20, lineHeight: '30px' }}>{state.agent.summary}</p>
            <div className="app-footer inline">
              <span className="meta">Every external action still waits for a human.</span>
              <span className="grow" />
              <Button
                primary
                onClick={() => {
                  if (state.agent.id) void adapter.rest.patchAgent(state.workspace.id, state.agent.id, { setup_step: null }).catch(() => undefined);
                  nav(OV);
                }}
              >
                Start {agentName(state)}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
