// One hook that loads the workspace's lists on demand and hands back typed
// rows. Each list is fetched at most once per session (the adapter keeps the
// in-flight set), and a list the current screen never mentions is never
// fetched — which is what keeps the first paint one bootstrap.
import { useEffect } from 'react';
import type { AgentFile, ContextField, DocumentEntity, EventRow, InstructionVersion, InvitationEntity, MaskedProviderKey, MemberEntity, RequestEntity, SkillVersion, TraceEntity } from '@hermes/shared';
import { useAdapter, useAppState } from '../store-context.js';
import { LIST_KEYS, rows } from '../selectors.js';
import type { AppState, EntityKind } from '../../model/store.js';

interface Loaded {
  requests: RequestEntity[];
  documents: DocumentEntity[];
  members: MemberEntity[];
  invitations: InvitationEntity[];
  history: EventRow[];
  traces: TraceEntity[];
  agentFiles: AgentFile[];
  contextFields: ContextField[];
  instructions: InstructionVersion[];
  skills: SkillVersion[];
  providerKeys: MaskedProviderKey[];
  loading: boolean;
}

type Row = { kind: EntityKind; id: string; data: unknown; version?: number };
// `version` is the optimistic-concurrency integer where a row carries one; a
// skill's `version` is its human-readable "v3", so it is read defensively.
const page = (kind: EntityKind, items: readonly { id: string }[]): { ids: string[]; cursor: null; total: number; rows: Row[] } => ({
  ids: items.map((item) => item.id),
  cursor: null,
  total: items.length,
  rows: items.map((item) => {
    const version = (item as { version?: unknown }).version;
    return { kind, id: item.id, data: item, version: typeof version === 'number' ? version : 1 };
  }),
});

export function useWorkspaceLists(): Loaded {
  const state = useAppState();
  const adapter = useAdapter();
  const workspaceId = state.workspace.id;
  const agentId = state.agent.id;

  // Which lists the cache currently holds. It is part of the effect's
  // dependencies so that a list dropped by `list/invalidate` — a decision
  // rewrites History, for instance — is fetched again rather than staying
  // whatever it was when the shell mounted. `ensureList` is idempotent: a list
  // that is `ready` or already in flight costs nothing.
  const loadedKeys = Object.values(LIST_KEYS)
    .filter((key) => state.entities.lists[key])
    .join(',');

  useEffect(() => {
    if (!workspaceId) return;
    const rest = adapter.rest;
    // Load both personal presentation states once; Inbox filters them locally
    // so a hide/restore response can move a row without a second network list.
    adapter.ensureList(LIST_KEYS.requests, async () => page('request', (await rest.listRequests(workspaceId, '?visibility=all')).items));
    adapter.ensureList(LIST_KEYS.documents, async () => page('document', (await rest.listDocuments(workspaceId)).items));
    adapter.ensureList(LIST_KEYS.members, async () => page('member', (await rest.listMembers(workspaceId)).items));
    adapter.ensureList(LIST_KEYS.invitations, async () => page('invitation', (await rest.listInvitations(workspaceId)).items));
    adapter.ensureList(LIST_KEYS.history, async () => page('event', (await rest.listEvents(workspaceId)).items));
    if (agentId) {
      adapter.ensureList(LIST_KEYS.traces, async () =>
        page('trace', (await rest.listTraces(workspaceId, `?agent_id=${encodeURIComponent(agentId)}`)).items),
      );
    }
    adapter.ensureList(LIST_KEYS.agentFiles, async () => page('agent_file', (await rest.listAgentFiles(workspaceId)).items));
    adapter.ensureList(LIST_KEYS.contextFields, async () => page('context_field', (await rest.listContextFields(workspaceId)).items));
    adapter.ensureList(LIST_KEYS.instructions, async () => page('instruction_version', (await rest.listInstructions(workspaceId)).items));
    adapter.ensureList(LIST_KEYS.skills, async () => page('skill_version', (await rest.listSkills(workspaceId, agentId)).items));
    adapter.ensureList(LIST_KEYS.providerKeys, async () => page('provider_key', (await rest.providerKeys(workspaceId)).keys));
  }, [adapter, workspaceId, agentId, loadedKeys]);

  const ready = (state_: AppState, key: string): boolean => state_.entities.lists[key]?.state === 'ready';

  return {
    requests: rows<RequestEntity>(state, LIST_KEYS.requests, 'request'),
    documents: rows<DocumentEntity>(state, LIST_KEYS.documents, 'document'),
    members: rows<MemberEntity>(state, LIST_KEYS.members, 'member'),
    invitations: rows<InvitationEntity>(state, LIST_KEYS.invitations, 'invitation'),
    history: rows<EventRow>(state, LIST_KEYS.history, 'event'),
    traces: rows<TraceEntity>(state, LIST_KEYS.traces, 'trace'),
    agentFiles: rows<AgentFile>(state, LIST_KEYS.agentFiles, 'agent_file'),
    contextFields: rows<ContextField>(state, LIST_KEYS.contextFields, 'context_field'),
    instructions: rows<InstructionVersion>(state, LIST_KEYS.instructions, 'instruction_version'),
    skills: rows<SkillVersion>(state, LIST_KEYS.skills, 'skill_version'),
    providerKeys: rows<MaskedProviderKey>(state, LIST_KEYS.providerKeys, 'provider_key'),
    loading: !ready(state, LIST_KEYS.requests),
  };
}
