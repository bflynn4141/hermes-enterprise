// Stable object references, ported from the demo's `src/model/refs.mjs`.
//
// A ref names an object in the app pane. The same shape is carried by chat
// blocks, by `run.focus` events and by client navigation, so "what Iris is
// looking at" and "what the human is looking at" are comparable values rather
// than two vocabularies. Keeping the demo's exact field names means the kept
// reducer needs no translation layer when it is ported in M2.
import { z } from 'zod';

export const REF_SECTIONS = ['agents', 'inbox', 'members', 'history', 'library', 'settings'] as const;
export type RefSection = (typeof REF_SECTIONS)[number];

/** A view selection, not a database mutation or an arbitrary route. */
export const inboxFiltersSchema = z.object({
  status: z.enum(['pending', 'resolved']).optional(),
  kind: z.enum(['all', 'application', 'documents', 'invoice', 'agreement']).optional(),
  query: z.string().max(200).optional(),
}).strict();
export type InboxFilters = z.infer<typeof inboxFiltersSchema>;

export const refSchema = z
  .object({
    section: z.enum(REF_SECTIONS),
    view: z.string().min(1).max(64).optional(),
    id: z.string().min(1).max(128).optional(),
    sub: z.string().min(1).max(64).optional(),
    step: z.string().min(1).max(64).optional(),
    field: z.string().min(1).max(64).optional(),
    filters: inboxFiltersSchema.optional(),
  })
  .strict();

export type Ref = z.infer<typeof refSchema>;

export const OV: Ref = { section: 'agents', view: 'overview' };
export const CTX: Ref = { section: 'agents', view: 'context' };
export const CTX_DEST: Ref = { section: 'agents', view: 'context', field: 'destination' };
export const SKILLS_VIEW: Ref = { section: 'agents', view: 'skills' };
export const TRACES: Ref = { section: 'agents', view: 'traces' };
export const COMPARE: Ref = { section: 'agents', view: 'traces', sub: 'compare' };
export const INBOX: Ref = { section: 'inbox', view: 'list' };
export const MEMBERS: Ref = { section: 'members' };

export const TRACE = (id: string): Ref => ({ section: 'agents', view: 'trace', id });
export const REQ = (id: string, extra: Partial<Ref> = {}): Ref => ({ section: 'inbox', view: 'request', id, ...extra });
export const HISTORY = (view = 'decisions'): Ref => ({ section: 'history', view });
export const LIB = (view: string, id?: string): Ref => ({ section: 'library', view, ...(id ? { id } : {}) });
export const SETTINGS = (view = 'Notifications'): Ref => ({ section: 'settings', view });
export const SETUP = (step: string): Ref => ({ section: 'agents', view: 'setup', step });
export const FILE = (id: string): Ref => ({ section: 'library', view: 'documents', id: `file:${id}` });

export const FOCUS_VIEWS = ['overview', 'context', 'skills', 'traces', 'inbox', 'inbox_rules', 'members', 'history', 'documents'] as const;
export const viewFocusSchema = z.object({
  view: z.enum(FOCUS_VIEWS),
  filters: inboxFiltersSchema.optional(),
}).strict().refine((target) => target.view === 'inbox' || target.filters === undefined, {
  message: 'filters are only supported for the inbox view',
});

/** Only allowlisted, already-built screens can be requested by the model. */
export function viewFocusRef(target: z.infer<typeof viewFocusSchema>): Ref {
  switch (target.view) {
    case 'overview': return OV;
    case 'context': return CTX;
    case 'skills': return SKILLS_VIEW;
    case 'traces': return TRACES;
    case 'inbox': return { ...INBOX, filters: { status: 'pending', kind: 'all', query: '', ...target.filters } };
    case 'inbox_rules': return { section: 'inbox', view: 'rules' };
    case 'members': return MEMBERS;
    case 'history': return HISTORY();
    case 'documents': return LIB('documents');
  }
}

export const entityFocusSchema = z.object({
  entity_type: z.enum(['request', 'document', 'session', 'agent', 'member', 'file']),
  entity_id: z.string().trim().min(1).max(128),
}).strict();
export const setFocusInputSchema = z.union([viewFocusSchema, entityFocusSchema]);

const REF_KEYS = ['section', 'view', 'id', 'sub', 'step', 'field'] as const;

/**
 * Two refs name the same object. The demo compared five fields with `|| ''`
 * defaults; the port keeps that semantics and adds `field`, which the demo
 * used in `CTX_DEST` but never compared.
 */
export const sameRef = (a: Ref | null | undefined, b: Ref | null | undefined): boolean => {
  if (!a || !b) return false;
  return REF_KEYS.every((key) => (a[key] ?? '') === (b[key] ?? ''))
    && (a.filters?.status ?? 'pending') === (b.filters?.status ?? 'pending')
    && (a.filters?.kind ?? 'all') === (b.filters?.kind ?? 'all')
    && (a.filters?.query ?? '') === (b.filters?.query ?? '');
};
