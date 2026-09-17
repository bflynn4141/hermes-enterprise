// The Agents section: Overview, Context, Skills, Traces, Trace detail, Setup.
//
// Every fixture literal is gone. Traces read `run_steps`, Context reads
// `agent_files` and `agent_context_fields`, Skills reads `instruction_versions`
// and the shared skill library. What did not change is the shape of the screens
// or their copy.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CodeBlock, ContextCards, DiffTable, Flowchart, ThinkingState } from '@hermes/motion-components';
import { CTX, CTX_DEST, HISTORY, INBOX, OV, REQ, SKILLS_VIEW, TRACE, TRACES, type AgentFile, type ContextField, type InstructionVersion, type RequestEntity, type SkillVersion, type TraceEntity, type Ref } from '@hermes/shared';
import { useAdapter, useAppState, useEntity, useIsAdmin, useNav } from '../store-context.js';
import { Glass, KIND_ICON } from '../ui/icons.js';
import { Ack, Button, Dialog, EmptyState, IrisMark, Panel, Skeleton, Tabs } from '../ui/primitives.js';
import { AGENT_TABS, EMPTY } from '../../model/constants.js';
import { LIST_KEYS, agentName, requestStatusLabel, rows } from '../selectors.js';
import { useWorkspaceLists } from './lists.js';
import { approvalActionLabel, approvalIcon, approvalTypeLabel, matchesReviewerFilter } from './Approval.js';
import { agentActivity, type AgentActivityState } from './agent-activity.js';

function AgentHead({ full }: { full?: boolean }) {
  const state = useAppState();
  return (
    <div className="agent-head">
      {full && <Glass name="iris" size={32} className="mark" />}
      <div className="col" style={{ gap: 2 }}>
        <h1 className="display-32">{agentName(state)}</h1>
        {full && state.agent.email && <div className="meta">{state.agent.email}</div>}
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
  const type = request.kind === 'application' ? 'Program admission' : request.kind === 'invoice' ? 'Create invoice' : request.kind === 'agreement' ? 'Create agreement' : approvalTypeLabel(request);
  return (
    <div className="list-row">
      <Glass name={request.kind === 'approval' ? approvalIcon(request) : KIND_ICON[request.kind] ?? 'context'} size={32} className="row-icon" />
      <div className="row-id">
        <span className="t">{request.subject ?? request.label}</span>
        <span className="s">{request.title ?? ''}</span>
      </div>
      <div className="row-main">
        <span className="t">{type}</span>
        <span className="s">{requestStatusLabel(request)}</span>
      </div>
      <Button onClick={onAction}>{request.kind === 'approval' ? approvalActionLabel(request) : action} →</Button>
    </div>
  );
}

const activityMarkState = (state: AgentActivityState): 'reading' | 'waiting' | 'stopped' | 'static' =>
  state === 'working' ? 'reading' : state === 'waiting' ? 'waiting' : state === 'stopped' ? 'stopped' : 'static';

function AgentActivityPanel({ traces }: { traces: readonly TraceEntity[] }) {
  const state = useAppState();
  const nav = useNav();
  const prefersReducedMotion = useReducedMotion();
  const activity = agentActivity(state, traces);
  const reduced = state.ui.reduceMotion || Boolean(prefersReducedMotion);
  const target = activity.traceId ? TRACE(activity.traceId) : TRACES;

  return (
    <section className="agent-activity-card" data-activity-state={activity.state} aria-label="Agent activity">
      <div className="agent-activity-head">
        <span className="agent-activity-mark">
          <IrisMark size={32} state={activityMarkState(activity.state)} />
        </span>
        <div className="agent-activity-identity">
          <span className="agent-activity-title">{state.workspace.name}</span>
          <span className="agent-activity-subtitle">{state.agent.summary || 'Screening · Drafting · Routing'}</span>
        </div>
        <div className="agent-activity-actions">
          <span className="agent-activity-status" role="status" aria-live="polite">
            <i aria-hidden="true" />
            {activity.status}
          </span>
          <Button link onClick={() => nav(target)}>{activity.traceId ? 'View trace →' : 'View traces →'}</Button>
        </div>
      </div>

      <div className="agent-activity-feed">
        <motion.div
          className="agent-activity-update"
          key={activity.key}
          initial={reduced ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduced ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="agent-activity-label">{activity.label}</span>
          <span className="agent-activity-task">{activity.task}</span>
          {activity.tool && (
            <>
              <span className="agent-activity-label">{activity.tool.state === 'active' ? 'Tool running' : 'Last tool'}</span>
              <span className="agent-tool-pair" data-tool-state={activity.tool.state}>
                <i aria-hidden="true" />
                <code>{activity.tool.name}</code>
                <span aria-hidden="true">→</span>
                <span>{activity.tool.summary}</span>
              </span>
            </>
          )}
          {activity.action && <span className="agent-activity-action">{activity.action}</span>}
        </motion.div>
      </div>
    </section>
  );
}

export function AgentOverview() {
  const state = useAppState();
  const nav = useNav();
  const lists = useWorkspaceLists();
  const admin = useIsAdmin();
  const agent = agentName(state);
  const pending = lists.requests.filter((request) => request.status === 'pending' && matchesReviewerFilter(request, 'for_me'));
  const destination = rows<ContextField>(state, LIST_KEYS.contextFields, 'context_field').find((field) => field.field === 'destination');
  const blocked = destination ? !destination.value : false;
  if (lists.loading) return <div className="scroll"><div className="app-body"><Skeleton rows={4} /></div></div>;

  return (
    <div className="scroll">
      <div className="app-body">
        <AgentHead full />
        <AgentTabsRow value="overview" />
        <AgentActivityPanel traces={lists.traces} />
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
              title={EMPTY.overview(agent, state.capabilities.automatedTriggers)}
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
      .then(() => {
        // The list, not the row. `ensure` is a no-op for an id already in the
        // cache, and the cached row is the *stale* one — which is why the
        // Overview went on saying "a reply is paused" after the answer had
        // been written. Dropping the list is what makes the next render read
        // the server's own answer.
        adapter.invalidateList(LIST_KEYS.contextFields);
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
            <Panel
              icon="context"
              title="Stored sources"
              subtitle={state.capabilities.turnAttachments ? `${files.length} available files` : `${files.length} files · Not connected to agent runs`}
            />
            {files.length === 0 ? (
              <EmptyState icon="context" title={EMPTY.context} detail="Files can be stored and reviewed here. They are not available to agent runs yet." />
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
                <span className="v">{state.capabilities.turnAttachments ? 'Selected sources' : 'Chat messages only'}</span>
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

/**
 * Skills and instructions.
 *
 * Two things on one tab because they are the two ways the agent's behaviour
 * changes: a skill somebody else in the workspace published and this agent
 * adopted, and an instruction a run proposed and an Admin has to read.
 *
 * The proposal is rendered twice on purpose. `DiffTable` is the summary — one
 * row per line of what is running now, one row for what is proposed, and Save
 * is Accept — and the block under it is the full text of both, because the
 * table truncates and an instruction nobody read in full is an instruction
 * nobody agreed to.
 */
export function AgentSkills() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const lists = useWorkspaceLists();
  const [ack, setAck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = lists.instructions.find((row) => row.state === 'current');
  const proposed = lists.instructions.find((row) => row.state === 'proposed');
  const saved = lists.instructions.filter((row) => row.state === 'saved');
  const status = proposed ? 'Proposed' : current ? 'Current' : 'None';
  const adopted = lists.skills.filter((skill) => skill.adopted);
  const offered = lists.skills.filter((skill) => !skill.adopted);
  const agent = agentName(state);

  const refreshInstructions = (): void => {
    adapter.invalidateList(LIST_KEYS.instructions);
  };

  const decide = (verdict: 'accept' | 'discard'): void => {
    if (!proposed) return;
    setError(null);
    const call = verdict === 'accept' ? adapter.rest.acceptInstruction(state.workspace.id, proposed.id) : adapter.rest.discardInstruction(state.workspace.id, proposed.id);
    void call
      .then(() => {
        refreshInstructions();
        setAck(verdict === 'accept' ? 'Saved' : 'Discarded');
        setTimeout(() => setAck(null), 1600);
      })
      .catch((caught: unknown) => {
        const reason = (caught as { reason?: string }).reason ?? '';
        // `already_saved` / `already_discarded`: the row is in a final state,
        // which is not an error to recover from but must not read as a move.
        setError(reason.startsWith('already_') ? 'This version was already decided. Reload to see it.' : reason === 'not_admin' ? EMPTY.adminOnly : 'Could not record that. Try again.');
      });
  };

  // One row per line of what is running now, plus the proposal as the addition.
  // Nothing here is partially applicable: the server accepts or discards a
  // whole version, so the only toggle offered is the addition itself, and Save
  // is disabled until it is included.
  const diffRows = (current?.text ?? proposed?.before ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line, index) => ({ key: `current-${index}`, id: index === 0 ? 'Current' : ' ', dept: agent, email: line, removed: false }));

  return (
    <div className="scroll">
      <div className="app-body" style={{ minHeight: '100%' }}>
        <AgentHead />
        <AgentTabsRow value="skills" />

        <div className="row">
          <h2 className="section-title">Shared skills</h2>
          <span className="grow" />
          <span className="meta">{adopted.length} in use</span>
        </div>
        {lists.skills.length === 0 && <EmptyState icon="skill" title="No shared skills yet" detail={`A skill another workspace member published appears here for ${agent} to adopt.`} />}
        {adopted.map((skill) => (
          <Panel key={skill.id} icon="skill" title={`${skill.name} · ${skill.version}`} subtitle={`${skill.description || 'No description'} · shared by ${skill.shared_by}`} right={<span className="meta">In use</span>} />
        ))}
        {offered.map((skill) => (
          <div className="list-row" key={skill.id} style={{ minHeight: 96 }}>
            <Glass name="skill" size={28} className="row-icon" />
            <div className="row-main">
              <span className="t">
                {skill.name} · {skill.version}
              </span>
              <span className="s">
                {skill.description} · shared by {skill.shared_by}
              </span>
            </div>
            <span style={{ position: 'relative' }}>
              <Button
                disabled={!admin}
                onClick={() => {
                  void adapter.rest
                    .adoptSkill(state.workspace.id, skill.id)
                    .then(() => {
                      adapter.invalidateList(LIST_KEYS.skills);
                      setAck(skill.id);
                      setTimeout(() => setAck(null), 1600);
                    })
                    .catch(() => setError('Could not adopt that skill. Try again.'));
                }}
              >
                {admin ? `Add to ${agent}` : EMPTY.adminOnly}
              </Button>
              <Ack show={ack === skill.id} style={{ right: 0, top: -40 }}>
                Added
              </Ack>
            </span>
          </div>
        ))}

        <div className="row">
          <h2 className="section-title">Screening instructions</h2>
          <span className="grow" />
          <span className="meta">{status}</span>
        </div>
        {current && (
          <div className="col" style={{ gap: 6, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
            <span className="meta">Current · saved {new Date(current.created_at).toLocaleDateString()}</span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{current.text}</span>
          </div>
        )}
        {proposed ? (
          <>
            <div className="hermes-ui">
              <DiffTable
                title="Proposed screening instruction"
                columns={['Version', 'Source', 'Instruction']}
                rows={diffRows}
                addedRow={{ key: 'proposed', id: 'Proposed', dept: agent, email: proposed.text.split('\n')[0] ?? proposed.text, removed: false }}
                {...(admin ? { onApply: async () => decide('accept') } : {})}
              />
            </div>
            <div className="diff-block">
              <span className="k">Add for future reviews</span>
              <span className="v" style={{ whiteSpace: 'pre-wrap' }}>
                {proposed.text}
              </span>
              <span className="k">{proposed.provenance ?? 'no provenance recorded'}</span>
            </div>
          </>
        ) : (
          <div className="note-block">
            <span className="t">{EMPTY.skills}</span>
            <span className="s">A run proposes a change when it learns something worth keeping. There is no way to write one here: an instruction version is written by the engine and reviewed by a person.</span>
          </div>
        )}
        {saved.length > 0 && (
          <>
            <h2 className="section-title">Earlier versions</h2>
            <div className="col">
              {saved.map((row) => (
                <div className="list-row compact" key={row.id}>
                  <Glass name="skill" size={22} className="row-icon" />
                  <div className="row-main">
                    <span className="t">{row.text.split('\n')[0]}</span>
                    <span className="s">
                      {new Date(row.created_at).toLocaleDateString()}
                      {row.provenance ? ` · ${row.provenance}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {error && <p className="meta" role="alert">{error}</p>}
        {!admin && <p className="meta">Read-only. {EMPTY.adminOnly}</p>}
        {admin && (
          <div className="app-footer inline">
            <span className="meta">Applies from the next screening · Shared skills unchanged</span>
            <span className="grow" />
            <span style={{ position: 'relative', display: 'inline-flex', gap: 12 }}>
              <Button disabled={!proposed} onClick={() => decide('discard')}>
                Discard
              </Button>
              <Button primary disabled={!proposed} onClick={() => decide('accept')}>
                Accept
              </Button>
              <Ack show={ack === 'Saved' || ack === 'Discarded'} style={{ right: 0, top: -40 }}>
                {ack ?? ''}
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

/** JSON if it parses, the raw string if it does not. Never a throw. */
function prettyJson(raw: string): string[] {
  const text = raw.trim();
  try {
    return JSON.stringify(JSON.parse(text), null, 2).split('\n');
  } catch {
    return text.split('\n');
  }
}

/**
 * `Flowchart`'s node and edge shapes.
 *
 * The library's `index.ts` exports the components as defaults and their prop
 * types are not re-exported, and the package's `exports` map has no subpath, so
 * there is nothing to import them from. Declared here, structurally, rather
 * than reached for through a path the package does not publish.
 */
type FlowNode = { id: string; row: number; x: number; w: number; kind?: { label: string; hue: string }; hue?: string; title?: string; caption?: string };
type FlowEdge = { from: string; to: string };

const HUE_TOOL = 'var(--purple, #7c6cf5)';
const HUE_THINK = 'var(--blue, #4a86ff)';
const HUE_FAILED = 'var(--red, #d2453c)';

/**
 * The run's steps as a flowchart.
 *
 * One node per `run_steps` row, in the order the engine wrote them, edges
 * between consecutive rows. It is read-only: `onMove` and `onSelect` are not
 * wired, because dragging a node would imply the reader could change the run,
 * and `condition` is never set, because a trace has no branch to edit. Ids are
 * the array index and not `step.id`: the engine reuses `provider` for every
 * model call, and two nodes with one id draw one node.
 */
function RunFlow({ steps }: { steps: TraceEntity['steps'] }) {
  const { nodes, edges } = useMemo(() => {
    const nodes: FlowNode[] = steps.slice(0, 12).map((step, index) => ({
      id: `s${index}`,
      row: index,
      x: 0.5,
      w: 300,
      kind: { label: step.tool_call_id ? 'Tool' : 'Model', hue: step.tool_call_id ? HUE_TOOL : HUE_THINK },
      hue: step.state === 'failed' ? HUE_FAILED : step.tool_call_id ? HUE_TOOL : HUE_THINK,
      title: step.label,
      caption: step.state === 'failed' ? `failed · attempt ${step.step_attempt}` : `${step.state} · attempt ${step.step_attempt}`,
    }));
    const edges: FlowEdge[] = nodes.slice(1).map((node, index) => ({ from: `s${index}`, to: node.id }));
    return { nodes, edges };
  }, [steps]);
  if (nodes.length === 0) return null;
  return (
    <div className="hermes-ui">
      <Flowchart steps={nodes} edges={edges} />
    </div>
  );
}

/**
 * One run, read back.
 *
 * Everything on this screen is already readable through another route; the
 * point of putting it together is the order. What the agent was allowed to do,
 * what it did, what it was handed back, where it sent the pane — in the
 * sequence it happened, so a reader can see what it read before it proposed
 * something.
 *
 * Two rules the server sets and the client keeps:
 *   * a truncated tool result is shown truncated, marker and all. Re-expanding
 *     it would be a trace of a run that did not happen;
 *   * opening a trace advances nothing. There is no control on this screen.
 */
export function TraceDetail({ id }: { id: string | null }) {
  const adapter = useAdapter();
  const record = useEntity<TraceEntity>('trace', id);
  const [open, setOpen] = useState<string | null>(null);

  /**
   * Force one fetch of the detail.
   *
   * The list and the detail are the same entity kind, and the list rows are
   * the *half* of it: `GET /w/:ws/traces` fills steps and leaves `tool_calls`,
   * `fetched_urls` and `focus` out entirely. `useEntity` only fetches on a
   * miss, so opening a trace from the Traces tab found the list's row already
   * cached and rendered "This run called no tools" for a run that had called
   * one. The fix is a forced `ensure` keyed on the id — it runs once per trace
   * opened, and the response replaces the partial row with the whole one.
   */
  useEffect(() => {
    if (id) adapter.ensure('trace', id, true);
  }, [adapter, id]);
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
          <EmptyState
            icon="trace"
            title={record.state === 'unavailable' ? 'This server does not serve traces' : EMPTY.traceMissing}
            detail={record.state === 'unavailable' ? 'The client is newer than the Worker it is talking to.' : 'Runs are kept for 90 days.'}
          />
        </div>
      </div>
    );
  }
  const trace = record.data;
  const done = trace.steps.filter((step) => step.state === 'done').length;
  // Map five stages proportionally, and always show the real labels (spec §12.6).
  const stage = trace.steps.length ? Math.floor((done / trace.steps.length) * 4) : 0;
  const toolCalls = trace.tool_calls ?? [];
  const urls = trace.fetched_urls ?? [];
  const focus = trace.focus ?? [];
  const truncatedCount = toolCalls.filter((call) => call.truncated).length;

  return (
    <div className="scroll">
      <div className="app-body">
        <AgentHead />
        <AgentTabsRow value="traces" />
        <div className="row">
          <h2 className="display-28">
            {trace.name} · {trace.type}
          </h2>
          <span className="grow" />
          <span className="meta">{trace.status}</span>
        </div>
        <Panel icon="trace" title={trace.sub} subtitle={`${trace.runtime_kind === 'hermes' ? 'Hermes Agent' : 'Previous runtime'} · ${trace.model_id ?? 'unknown model'}`} />

        <h2 className="section-title">Steps</h2>
        <div className="hermes-ui">
          <ThinkingState stage={stage} rows={trace.steps.map((step) => ({ primary: step.label, ...(step.detail ? { secondary: step.detail } : {}) }))} active={trace.status} done={`${done} of ${trace.steps.length} steps`} additionalSources={0} />
        </div>
        <RunFlow steps={trace.steps} />

        <div className="row">
          <h2 className="section-title">Tool calls</h2>
          <span className="grow" />
          {truncatedCount > 0 && (
            <span className="meta">
              {truncatedCount} result{truncatedCount === 1 ? '' : 's'} truncated at 8 KB
            </span>
          )}
        </div>
        {toolCalls.length === 0 ? (
          <div className="meta" style={{ padding: '12px 0' }}>This run called no tools.</div>
        ) : (
          <div className="col">
            {toolCalls.map((call) => (
              <div className="col" key={call.tool_call_id} style={{ gap: 10, padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="list-row compact" style={{ borderBottom: 0 }}>
                  <Glass name="trace" size={22} className="row-icon" />
                  <div className="row-main">
                    <span className="t">{call.name}</span>
                    <span className="s">
                      turn {call.turn} · {call.tool_call_id}
                      {call.truncated ? ' · result truncated at 8 KB' : ''}
                    </span>
                  </div>
                  <Button link onClick={() => setOpen(open === call.tool_call_id ? null : call.tool_call_id)}>
                    {open === call.tool_call_id ? 'Hide' : 'Show'} arguments and result
                  </Button>
                </div>
                {open === call.tool_call_id && (
                  <div className="col" style={{ gap: 14 }}>
                    <div className="hermes-ui">
                      <CodeBlock filename={`${call.name}.arguments.json`} lines={prettyJson(call.arguments ?? 'null')} diff={[]} />
                    </div>
                    <div className="hermes-ui">
                      <CodeBlock filename={`${call.name}.result.json`} lines={prettyJson(call.result ?? 'null')} diff={[]} />
                    </div>
                    {call.truncated && (
                      <p className="meta">
                        The model was handed exactly this, truncation marker included. It is shown as the model saw it, not re-expanded.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <h2 className="section-title">Pages fetched</h2>
        {urls.length === 0 ? (
          <div className="meta" style={{ padding: '12px 0' }}>No page was fetched. `fetch_url` reaches only the hosts on the workspace allowlist, and an empty allowlist reaches nothing.</div>
        ) : (
          <div className="hermes-ui">
            <ContextCards
              labels={{ header: 'Pages fetched', count: `${urls.length}` }}
              chunks={urls.map((url, index) => ({
                title: safeHost(url),
                chars: `${url.length}`,
                body: url,
                source: `fetch ${index + 1}`,
                badge: 'untrusted',
                tone: 'amber',
              }))}
            />
          </div>
        )}

        <h2 className="section-title">Where it sent the pane</h2>
        {focus.length === 0 ? (
          <div className="meta" style={{ padding: '12px 0' }}>This run moved nobody's focus.</div>
        ) : (
          <div className="col">
            {focus.map((entry, index) => (
              <div className="list-row compact" key={`${entry.entity_id}-${index}`}>
                <span className="time">{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <div className="row-main">
                  <span className="t">{entry.entity_type}</span>
                  <span className="s">{entry.ref ? `${entry.ref.section}${entry.ref.view ? ` · ${entry.ref.view}` : ''} · ${entry.entity_id}` : entry.entity_id}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <Panel icon="trace" title="Allowed tools" subtitle={trace.allowed_tools.join(' · ') || 'None recorded for this workspace'} />
        <p className="meta">Opening a trace never advances a run or decides anything. The trace shows sources, findings and named human decisions, not hidden reasoning.</p>
      </div>
    </div>
  );
}

/** A URL's host, or the URL itself when it does not parse. Never a throw. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
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
            <Panel icon="iris" title={agentName(state)} subtitle={state.agent.email ?? 'Email not connected'} right={<span className="meta">Loop not started</span>} />
            <div className="row">
              <Button primary onClick={() => goto('context')}>
                Continue
              </Button>
            </div>
          </>
        )}
        {step === 'context' && (
          <>
            <Panel icon="context" title="Stored sources" subtitle={`${lists.agentFiles.length} files · Not connected to agent runs`} />
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
                {['Work from chat messages', 'Prepare reports and drafts', 'Ask for a decision'].map((title) => (
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
            <Panel icon="iris" title={agentName(state)} subtitle={state.agent.email ?? 'Email not connected'} right={<span className="meta">Loop not started</span>} />
            <p style={{ fontSize: 16, lineHeight: '24px' }}>{state.agent.summary}</p>
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
