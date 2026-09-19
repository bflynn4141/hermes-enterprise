import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  REQ,
  type Attachment,
  type InvoicePayload,
  type PartnerEngagementAuthorizationInput,
  type PartnerEngagementSummary,
  type PartnerHandoffResult,
  type PartnerInputProvenance,
  type PartnerInvoiceCorrectionInput,
  type PartnerInvoiceIntakeInput,
  type PartnerRoleReadiness,
  type PartnerWorkflowHandoffV2,
  type PartnerWorkflowSetup,
  type PartnerWorkflowViewV2,
} from '@hermes/shared';
import { RestError } from '../../model/rest.js';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Glass } from '../ui/icons.js';
import { Button, EmptyState, Skeleton } from '../ui/primitives.js';
import { InputProvenanceBadge } from '../input-provenance.js';

const DOCUMENT_ACCEPT = '.pdf,.md,.txt,application/pdf,text/markdown,text/plain';

function workflowKey(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `client:${random}`;
}

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

const missingCopy: Record<PartnerRoleReadiness['missing'][number], string> = {
  principal: 'Assign an employee',
  agent: 'Bind a dedicated Hermes profile',
  assignment: 'Apply the role assignment',
  skill: 'Install the reviewed native skill',
  tools: 'Restore the exact connector tools',
  provider: 'Connect an available model provider',
};

function missingReadinessCopy(readiness: PartnerRoleReadiness, item: PartnerRoleReadiness['missing'][number]): string {
  if (item === 'skill') return `Upgrade the native profile to ${readiness.role === 'finance' ? 'Finance1.0.1' : 'Partnerships1.8'}`;
  if (item === 'provider') return 'Record the model provider readiness attestation';
  return missingCopy[item];
}

function workflowError(error: unknown): string {
  if (!(error instanceof RestError)) return 'The server did not complete that action. Your fields are still here; try again.';
  switch (error.reason) {
    case 'attachment_not_ready': return 'The source is still being prepared. Wait a moment and try again.';
    case 'attachment_not_accessible': return 'You no longer have access to that source. Choose a source you can open.';
    case 'source_workspace_mismatch': return 'That source belongs to another workspace. Choose a source from this workspace.';
    case 'source_digest_mismatch': return 'The source changed after upload. Upload the current file and confirm it again.';
    case 'engagement_not_authorized': return 'Finance has not authorized these engagement terms.';
    case 'engagement_revision_mismatch':
    case 'authorization_hash_mismatch': return 'The engagement changed. The latest authorized terms have been reloaded.';
    case 'authorization_revoked': return 'This engagement authorization was revoked.';
    case 'authorization_expired': return 'This engagement authorization expired.';
    case 'authorization_superseded': return 'Newer engagement terms replaced this authorization.';
    case 'authorization_consumed': return 'This one-invoice engagement has already been used.';
    case 'handoff_revision_mismatch':
    case 'handoff_superseded':
    case 'correction_successor_exists': return 'A newer invoice correction already exists. The workflow has been reloaded.';
    case 'handoff_already_decided': return 'Finance has already recorded a decision for this invoice.';
    case 'idempotency_conflict': return 'This submission key was already used for different fields. Review the latest workflow before trying again.';
    case 'partnerships_principal_required': return 'Only the configured Partnerships employee can submit this invoice.';
    case 'finance_recipient_unavailable': return 'Finance is not ready to receive this invoice yet.';
    case 'workflow_not_configured': return 'Assign both employee profiles before enabling this workflow.';
    case 'workflow_readiness_incomplete': return 'Both native profiles need the required version, tools, and provider attestation before this workflow can be enabled.';
    case 'workflow_admission_disabled': return 'An Admin must enable this workflow after both native profiles are ready.';
    case 'skill_artifact_mismatch': return 'The installed native skill does not match the reviewed workflow artifact.';
    case 'legacy_handoff_input_forbidden': return 'This historical handoff does not record its input source, so it cannot be corrected as customer data.';
    case 'forbidden_partner_workflow_action': return 'Your role cannot perform this action.';
    default: return error.message || 'The server did not complete that action. Your fields are still here; try again.';
  }
}

function readinessLabel(readiness: PartnerRoleReadiness): string {
  if (!readiness.configured) return 'Setup needed';
  if (readiness.assignment_state === 'paused') return 'Paused';
  if (readiness.native_status === 'ready') return 'Ready';
  if (readiness.native_status === 'not_ready') return 'Needs attention';
  return 'Checking native profile';
}

function RoleReadinessCard({ readiness, workflow }: { readiness: PartnerRoleReadiness; workflow: PartnerWorkflowViewV2 }) {
  const agent = workflow.agents.find((item) => item.team.slug === readiness.role);
  const ready = readiness.native_status === 'ready' && readiness.assignment_state === 'active';
  return (
    <article className="partner-role-card" data-ready={ready}>
      <div className="partner-role-card-head">
        <Glass name={readiness.role === 'finance' ? 'invoice' : 'people'} size={28} />
        <div className="col grow">
          <h3>{readiness.role === 'finance' ? 'Finance' : 'Partnerships'}</h3>
          <span className="meta">{agent ? `${agent.principal_name} · ${agent.name}` : 'Employee and agent not assigned'}</span>
        </div>
        <span className={`pill ${ready ? 'pill-ok' : readiness.native_status === 'not_ready' ? 'pill-warn' : ''}`}>{readinessLabel(readiness)}</span>
      </div>
      <p>{readiness.role === 'finance' ? 'Checks received invoices and prepares the evidence for a Finance human decision.' : 'Records agreed terms and submits received invoices with confirmed fields.'}</p>
      {agent && <p className="meta">{agent.role_template.name} · {readiness.skill_version ? `skill ${readiness.skill_version}` : 'skill version unavailable'} · schedule {agent.schedule_enabled ? 'on' : 'off'}</p>}
      {readiness.missing.length > 0 && (
        <ul className="partner-missing-list">
          {readiness.missing.map((item) => <li key={item}>{missingReadinessCopy(readiness, item)}</li>)}
        </ul>
      )}
    </article>
  );
}

function UploadedSource({
  label,
  source,
  onSource,
  disabled,
}: {
  label: string;
  source: Attachment | null;
  onSource: (source: Attachment | null) => void;
  disabled: boolean;
}) {
  const adapter = useAdapter();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    setError(null);
    try {
      const ready = await adapter.upload(file, { kind: 'attachment' });
      if (!ready.sha256) throw new Error('Source digest missing');
      onSource(ready);
    } catch {
      setError('Could not verify that file. Use PDF, Markdown, or text and try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="partner-source-field">
      <span className="partner-field-label">{label}</span>
      {source ? (
        <div className="partner-source-confirmed">
          <Glass name="context" size={22} />
          <span className="grow"><strong>{source.name}</strong><small>Stored and verified · {source.sha256?.slice(0, 12)}…</small></span>
          <Button small disabled={disabled} onClick={() => { onSource(null); if (input.current) input.current.value = ''; }}>Replace</Button>
        </div>
      ) : (
        <label className="partner-file-button">
          <input
            ref={input}
            type="file"
            accept={DOCUMENT_ACCEPT}
            disabled={disabled || uploading}
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }}
          />
          <span>{uploading ? 'Verifying source…' : 'Choose source file'}</span>
          <small>PDF, Markdown, or text · up to 20 MB</small>
        </label>
      )}
      {error && <p className="partner-inline-error" role="alert">{error}</p>}
    </div>
  );
}

interface EngagementDraft {
  partnerId: string;
  partnerName: string;
  reference: string;
  purpose: string;
  currency: string;
  amount: string;
  validFrom: string;
  validUntil: string;
  excerpt: string;
}

const emptyEngagementDraft = (): EngagementDraft => ({
  partnerId: '', partnerName: '', reference: '', purpose: '', currency: 'USD', amount: '',
  validFrom: new Date().toISOString().slice(0, 10),
  validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  excerpt: '',
});

function WorkflowSetupForm({ onClose, onSaved }: { onClose: () => void; onSaved: (view: PartnerWorkflowViewV2) => void }) {
  const adapter = useAdapter();
  const state = useAppState();
  const reduce = useReducedMotion();
  const [partnershipsUser, setPartnershipsUser] = useState(state.user.id);
  const [partnershipsAgent, setPartnershipsAgent] = useState(state.agent.id ?? '');
  const [financeUser, setFinanceUser] = useState('');
  const [financeAgent, setFinanceAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = Boolean(partnershipsUser && partnershipsAgent && financeUser && financeAgent && partnershipsUser !== financeUser && partnershipsAgent !== financeAgent);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) return;
    const body: PartnerWorkflowSetup = {
      partnerships: { principal_user_id: partnershipsUser.trim(), agent_id: partnershipsAgent.trim() },
      finance: { principal_user_id: financeUser.trim(), agent_id: financeAgent.trim() },
    };
    setBusy(true);
    setError(null);
    void adapter.rest.configurePartnerWorkflow(state.workspace.id, body)
      .then(onSaved)
      .catch((caught: unknown) => setError(workflowError(caught)))
      .finally(() => setBusy(false));
  };
  return (
    <motion.form className="partner-workflow-form" aria-label="Configure employee roles" onSubmit={submit} initial={{ opacity: 0, y: reduce ? 0 : -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .16, ease: [0.22, 1, 0.36, 1] }}>
      <header><div><h3>Configure two employee profiles</h3><p>Bind two existing users to two dedicated native Hermes profiles. Saving role assignments does not make a missing skill, tool, or provider ready.</p></div><Button small onClick={onClose}>Close</Button></header>
      <div className="partner-form-grid">
        <label><span>Partnerships employee user ID</span><input required value={partnershipsUser} onChange={(event) => setPartnershipsUser(event.target.value)} /></label>
        <label><span>Partnerships Hermes agent ID</span><input required value={partnershipsAgent} onChange={(event) => setPartnershipsAgent(event.target.value)} /></label>
        <label><span>Finance employee user ID</span><input required value={financeUser} onChange={(event) => setFinanceUser(event.target.value)} placeholder="Existing WorkOS user UUID" /></label>
        <label><span>Finance Hermes agent ID</span><input required value={financeAgent} onChange={(event) => setFinanceAgent(event.target.value)} placeholder="Dedicated native profile UUID" /></label>
      </div>
      {!valid && financeUser && financeAgent && (partnershipsUser === financeUser || partnershipsAgent === financeAgent) && <p className="partner-error" role="alert">Each role needs a distinct employee and a distinct Hermes agent.</p>}
      {error && <p className="partner-error" role="alert">{error}</p>}
      <footer><span className="meta">New schedules remain off. Readiness is checked from the native profiles after saving.</span><Button primary type="submit" disabled={!valid || busy}>{busy ? 'Saving roles…' : 'Save role assignments'}</Button></footer>
    </motion.form>
  );
}

function EngagementForm({ workflow, onClose, onSaved }: { workflow: PartnerWorkflowViewV2; onClose: () => void; onSaved: (requestId: string, inputProvenance: PartnerInputProvenance) => void }) {
  const adapter = useAdapter();
  const state = useAppState();
  const reduce = useReducedMotion();
  const [draft, setDraft] = useState(emptyEngagementDraft);
  const [source, setSource] = useState<Attachment | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [inputProvenance, setInputProvenance] = useState<PartnerInputProvenance>('sample');
  const [key, setKey] = useState(workflowKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountMinor = Math.round(Number(draft.amount) * 100);
  const valid = Boolean(source?.sha256 && confirmed && draft.partnerId && draft.partnerName && draft.reference && draft.purpose && draft.excerpt && /^[A-Z]{3}$/.test(draft.currency) && Number.isSafeInteger(amountMinor) && amountMinor >= 0);
  const field = (name: keyof EngagementDraft, value: string) => setDraft((current) => ({ ...current, [name]: value }));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid || !source?.sha256) return;
    const body: PartnerEngagementAuthorizationInput = {
      input_provenance: inputProvenance,
      partner: { id: draft.partnerId, name: draft.partnerName.trim() },
      reference: draft.reference.trim(), purpose: draft.purpose.trim(), currency: draft.currency.toUpperCase(),
      authorized_total_minor: amountMinor, valid_from: draft.validFrom, valid_until: draft.validUntil,
      one_invoice: true, permitted_evidence_excerpt: draft.excerpt.trim(),
      source: { attachment_id: source.id, expected_sha256: source.sha256 }, idempotency_key: key,
    };
    setBusy(true);
    setError(null);
    void adapter.rest.proposePartnerEngagement(state.workspace.id, body)
      .then((result) => {
        setKey(workflowKey());
        onSaved(result.approval_request_id, result.input_provenance);
      })
      .catch((caught: unknown) => setError(workflowError(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <motion.form className="partner-workflow-form" aria-label="Record agreed engagement terms" onSubmit={submit} initial={{ opacity: 0, y: reduce ? 0 : -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .16, ease: [0.22, 1, 0.36, 1] }}>
      <header><div><h3>{inputProvenance === 'sample' ? 'Record sample engagement terms' : 'Record agreed engagement terms'}</h3><p>{inputProvenance === 'sample' ? 'For demonstration only. This does not confirm an external agreement.' : 'Finance will verify these externally agreed terms before they can authorize one invoice.'} This does not sign an agreement or authorize payment.</p></div><Button small onClick={onClose}>Close</Button></header>
      <fieldset className="partner-provenance-choice">
        <legend>What kind of input is this?</legend>
        <label><input type="radio" name="engagement-provenance" value="sample" checked={inputProvenance === 'sample'} onChange={() => setInputProvenance('sample')} /><span><strong>Sample data</strong><small>For testing or demonstration. It does not confirm an external agreement.</small></span></label>
        <label><input type="radio" name="engagement-provenance" value="customer" checked={inputProvenance === 'customer'} onChange={() => setInputProvenance('customer')} /><span><strong>Customer data</strong><small>From externally agreed terms with a verifiable source.</small></span></label>
      </fieldset>
      <div className="partner-form-grid">
        <label className="partner-form-wide"><span>Partner</span><select required value={draft.partnerId} onChange={(event) => { const option = workflow.partner_options.find((item) => item.id === event.target.value); setDraft((current) => ({ ...current, partnerId: event.target.value, partnerName: option?.name ?? '' })); }}><option value="">Choose a partner from stored work</option>{workflow.partner_options.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.source}</option>)}</select></label>
        <label><span>Reference</span><input required value={draft.reference} onChange={(event) => field('reference', event.target.value)} placeholder="ENG-2026-042" /></label>
        <label><span>Purpose</span><input required value={draft.purpose} onChange={(event) => field('purpose', event.target.value)} placeholder="Partner enablement workshop" /></label>
        <label><span>Currency</span><input required maxLength={3} value={draft.currency} onChange={(event) => field('currency', event.target.value.toUpperCase())} /></label>
        <label><span>Authorized total</span><input required type="number" min="0" step="0.01" inputMode="decimal" value={draft.amount} onChange={(event) => field('amount', event.target.value)} /></label>
        <label><span>Valid from</span><input required type="date" value={draft.validFrom} onChange={(event) => field('validFrom', event.target.value)} /></label>
        <label><span>Valid until</span><input required type="date" value={draft.validUntil} onChange={(event) => field('validUntil', event.target.value)} /></label>
        <label className="partner-form-wide"><span>Permitted evidence excerpt</span><textarea required rows={3} value={draft.excerpt} onChange={(event) => field('excerpt', event.target.value)} placeholder="The exact source excerpt Finance may review" /></label>
      </div>
      <UploadedSource label={inputProvenance === 'sample' ? 'Source of the sample terms' : 'Source of the externally agreed terms'} source={source} onSource={(next) => { setSource(next); setConfirmed(false); }} disabled={busy} />
      <label className="partner-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I checked these {inputProvenance === 'sample' ? 'sample terms' : 'externally agreed terms'} and the permitted excerpt against the stored source.</span></label>
      {error && <p className="partner-error" role="alert">{error}</p>}
      <footer><span className="meta">Creates a record-change proposal for the named Finance reviewer.</span><Button primary disabled={!valid || busy} type="submit">{busy ? 'Creating proposal…' : inputProvenance === 'sample' ? 'Send sample terms to Finance' : 'Send to Finance for authorization'}</Button></footer>
    </motion.form>
  );
}

interface InvoiceDraft {
  number: string;
  payee: string;
  payer: string;
  issueDate: string;
  dueDate: string;
  description: string;
  amount: string;
  currency: string;
  notes: string;
}

function invoiceDraft(engagement: PartnerEngagementSummary | null, handoff: PartnerWorkflowHandoffV2 | null): InvoiceDraft {
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  return {
    number: handoff?.invoice_number ?? '', payee: engagement?.partner.name ?? handoff?.partner_name ?? '', payer: 'Nous Research',
    issueDate: today, dueDate: due, description: engagement?.purpose ?? '',
    amount: handoff ? (handoff.invoice_total_minor / 100).toFixed(2) : '',
    currency: engagement?.currency ?? handoff?.invoice_currency ?? 'USD', notes: '',
  };
}

function InvoiceForm({
  workflow,
  correction,
  onClose,
  onSaved,
}: {
  workflow: PartnerWorkflowViewV2;
  correction: PartnerWorkflowHandoffV2 | null;
  onClose: () => void;
  onSaved: (handoffId: string) => void;
}) {
  const adapter = useAdapter();
  const state = useAppState();
  const reduce = useReducedMotion();
  const eligible = workflow.engagements.filter((item) => item.authorization_status === 'authorized');
  const correctedEngagement = correction ? workflow.engagements.find((item) => item.reference === correction.engagement_reference) ?? null : null;
  const [engagementId, setEngagementId] = useState(correctedEngagement?.id ?? eligible[0]?.id ?? '');
  const engagement = workflow.engagements.find((item) => item.id === engagementId) ?? correctedEngagement ?? null;
  const [draft, setDraft] = useState(() => invoiceDraft(engagement, correction));
  const [source, setSource] = useState<Attachment | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const initialProvenance: PartnerInputProvenance = correction?.input_provenance === 'sample' || correction?.input_provenance === 'unknown' || engagement?.input_provenance === 'sample' ? 'sample' : 'customer';
  const [inputProvenance, setInputProvenance] = useState<PartnerInputProvenance>(initialProvenance);
  const [key, setKey] = useState(workflowKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountMinor = Math.round(Number(draft.amount) * 100);
  const valid = Boolean(engagement && source?.sha256 && confirmed && draft.number && draft.payee && draft.payer && draft.issueDate && draft.dueDate && draft.description && Number.isSafeInteger(amountMinor) && amountMinor >= 0);
  const field = (name: keyof InvoiceDraft, value: string) => setDraft((current) => ({ ...current, [name]: value }));

  const chooseEngagement = (id: string): void => {
    const next = workflow.engagements.find((item) => item.id === id) ?? null;
    setEngagementId(id);
    setInputProvenance(next?.input_provenance === 'sample' ? 'sample' : 'customer');
    setDraft((current) => ({ ...current, payee: next?.partner.name ?? current.payee, description: next?.purpose ?? current.description, currency: next?.currency ?? current.currency }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid || !engagement || !source?.sha256) return;
    const invoice: InvoicePayload = {
      kind: 'invoice', number: draft.number.trim(), currency: draft.currency.toUpperCase(),
      payee: { name: draft.payee.trim() }, payer: { name: draft.payer.trim() },
      issue_date: draft.issueDate, due_date: draft.dueDate,
      lines: [{ id: 'service-1', label: draft.description.trim(), qty: 1, amount_minor: amountMinor, source_ids: [source.id] }],
      total_minor: amountMinor, ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
    };
    const common = {
      input_provenance: inputProvenance,
      engagement_record_id: engagement.id,
      expected_engagement_revision: engagement.revision,
      expected_authorization_hash: engagement.authorization_hash,
      invoice_source: { attachment_id: source.id, expected_sha256: source.sha256 },
      invoice,
      idempotency_key: key,
    };
    setBusy(true);
    setError(null);
    const request = correction
      ? adapter.rest.correctPartnerInvoice(state.workspace.id, correction.id, { ...common, expected_handoff_revision: correction.revision } satisfies PartnerInvoiceCorrectionInput)
      : adapter.rest.submitPartnerInvoice(state.workspace.id, common satisfies PartnerInvoiceIntakeInput);
    void request
      .then((result) => { setKey(workflowKey()); onSaved(result.handoff_id); })
      .catch((caught: unknown) => setError(workflowError(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <motion.form className="partner-workflow-form" aria-label={correction ? 'Correct invoice' : 'Submit invoice to Finance'} onSubmit={submit} initial={{ opacity: 0, y: reduce ? 0 : -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .16, ease: [0.22, 1, 0.36, 1] }}>
      <header><div><h3>{correction ? `Correct ${correction.invoice_number}` : 'Submit invoice to Finance'}</h3><p>{correction ? 'The original mismatch stays in history. This creates one successor review.' : 'Upload the received source and confirm the fields Finance should check.'}</p></div><Button small onClick={onClose}>Close</Button></header>
      <fieldset className="partner-provenance-choice">
        <legend>What kind of invoice input is this?</legend>
        <label><input type="radio" name="invoice-provenance" value="sample" checked={inputProvenance === 'sample'} onChange={() => setInputProvenance('sample')} /><span><strong>Sample data</strong><small>For testing or demonstration.</small></span></label>
        <label><input type="radio" name="invoice-provenance" value="customer" checked={inputProvenance === 'customer'} disabled={engagement?.input_provenance === 'sample' || correction?.input_provenance === 'sample' || correction?.input_provenance === 'unknown'} onChange={() => setInputProvenance('customer')} /><span><strong>Customer data</strong><small>{engagement?.input_provenance === 'sample' || correction?.input_provenance === 'sample' ? 'Sample engagement lineage must stay sample.' : correction?.input_provenance === 'unknown' ? 'Historical input cannot be relabeled as customer data.' : 'From a received customer invoice.'}</small></span></label>
      </fieldset>
      <div className="partner-form-grid">
        <label className="partner-form-wide"><span>Authorized engagement</span><select disabled={Boolean(correction)} value={engagementId} onChange={(event) => chooseEngagement(event.target.value)}><option value="">Choose authorized terms</option>{workflow.engagements.map((item) => <option key={item.id} value={item.id} disabled={item.authorization_status !== 'authorized'}>{item.partner.name} · {item.reference} · {item.authorization_status}</option>)}</select></label>
        <label><span>Invoice number</span><input required value={draft.number} onChange={(event) => field('number', event.target.value)} /></label>
        <label><span>Amount</span><input required type="number" min="0" step="0.01" inputMode="decimal" value={draft.amount} onChange={(event) => field('amount', event.target.value)} /></label>
        <label><span>Currency</span><input required maxLength={3} value={draft.currency} onChange={(event) => field('currency', event.target.value.toUpperCase())} /></label>
        <label><span>Service or purpose</span><input required value={draft.description} onChange={(event) => field('description', event.target.value)} /></label>
        <label><span>From</span><input required value={draft.payee} onChange={(event) => field('payee', event.target.value)} /></label>
        <label><span>Bill to</span><input required value={draft.payer} onChange={(event) => field('payer', event.target.value)} /></label>
        <label><span>Issued</span><input required type="date" value={draft.issueDate} onChange={(event) => field('issueDate', event.target.value)} /></label>
        <label><span>Due</span><input required type="date" value={draft.dueDate} onChange={(event) => field('dueDate', event.target.value)} /></label>
        <label className="partner-form-wide"><span>Internal note (optional)</span><textarea rows={2} value={draft.notes} onChange={(event) => field('notes', event.target.value)} /></label>
      </div>
      <UploadedSource label={correction ? 'Corrected invoice source' : 'Received invoice source'} source={source} onSource={(next) => { setSource(next); setConfirmed(false); }} disabled={busy} />
      {engagement && <div className="partner-authority-summary"><strong>{money(engagement.authorized_total_minor, engagement.currency)} authorized</strong><span>{engagement.purpose}</span><small>{engagement.reference} · valid {engagement.valid_from} through {engagement.valid_until} · one invoice · <InputProvenanceBadge value={engagement.input_provenance} /></small></div>}
      <label className="partner-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I checked the invoice number, parties, dates, purpose, currency, and amount against {source?.name ?? 'the stored source'}.</span></label>
      {error && <p className="partner-error" role="alert">{error}</p>}
      <footer><span className="meta">Finance sees the confirmed fields and authorized evidence. No payment or email is sent.</span><Button primary disabled={!valid || busy} type="submit">{busy ? 'Submitting…' : correction ? 'Submit correction' : 'Submit invoice to Finance'}</Button></footer>
    </motion.form>
  );
}

type ProgressState = 'complete' | 'current' | 'waiting' | 'issue';

function progressFor(handoff: PartnerWorkflowHandoffV2): { label: string; state: ProgressState }[] {
  const validation = handoff.outcome.validation;
  const decision = handoff.outcome.human_decision;
  const checks: ProgressState = validation === 'passed' ? 'complete' : validation === 'queued' || validation === 'checking' ? 'current' : 'issue';
  const finance: ProgressState = decision === 'approved' || decision === 'declined' ? 'complete' : decision === 'pending' ? 'current' : validation === 'passed' ? 'current' : 'waiting';
  const recorded: ProgressState = decision === 'approved' || decision === 'declined' ? 'complete' : 'waiting';
  return [
    { label: 'Invoice received', state: 'complete' },
    { label: 'Checks complete', state: checks },
    { label: 'Awaiting Finance review', state: finance },
    { label: 'Decision recorded', state: recorded },
  ];
}

function outcomeLabel(handoff: PartnerWorkflowHandoffV2): string {
  if (handoff.outcome.human_decision === 'approved') return 'Invoice draft saved';
  if (handoff.outcome.human_decision === 'declined') return 'Declined by Finance';
  if (handoff.result_kind === 'needs_information') return 'Needs invoice correction';
  if (handoff.result_kind === 'stale_source') return 'Source changed';
  if (handoff.result_kind === 'failed_processing') return 'Processing failed';
  if (handoff.outcome.human_decision === 'pending') return 'Ready for Finance decision';
  return handoff.outcome.validation === 'checking' ? 'Checking invoice' : 'Invoice received';
}

function HandoffCard({ handoff, workflow, onCorrect }: { handoff: PartnerWorkflowHandoffV2; workflow: PartnerWorkflowViewV2; onCorrect: () => void }) {
  const state = useAppState();
  const nav = useNav();
  const adapter = useAdapter();
  const [result, setResult] = useState<PartnerHandoffResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const legacyCorrectionBlocked = handoff.input_provenance === 'unknown' && handoff.current && ['needs_information', 'stale_source'].includes(handoff.result_kind);
  const canCorrect = workflow.actions.correct_invoice && !legacyCorrectionBlocked && handoff.current && ['needs_information', 'stale_source'].includes(handoff.result_kind) && handoff.outcome.human_decision !== 'pending';
  const modelCopy = handoff.simulated
    ? 'Simulated execution · no model call'
    : handoff.outcome.agent_explanation === 'completed' ? 'Finance agent explanation ready'
      : handoff.outcome.agent_explanation === 'failed' || handoff.outcome.agent_explanation === 'stopped' ? 'Agent explanation unavailable'
        : handoff.outcome.agent_explanation === 'running' ? 'Finance agent is reviewing'
          : 'Finance agent review queued';

  const showEvidence = (): void => {
    setExpanded((open) => !open);
    if (!result) void adapter.rest.partnerHandoffResult(state.workspace.id, handoff.id).then(setResult).catch(() => undefined);
  };

  return (
    <article className="partner-handoff-card" data-current={handoff.current}>
      <header>
        <div><span className="partner-card-kicker">{handoff.partner_name} · {handoff.engagement_reference}</span><h3>{handoff.invoice_number}</h3><p>{money(handoff.invoice_total_minor, handoff.invoice_currency)}</p></div>
        <span className="row"><InputProvenanceBadge value={handoff.input_provenance} /><span className={`pill ${handoff.outcome.human_decision === 'approved' ? 'pill-ok' : ['needs_information', 'stale_source', 'failed_processing'].includes(handoff.result_kind) ? 'pill-warn' : ''}`}>{outcomeLabel(handoff)}</span></span>
      </header>
      <ol className="partner-progress" aria-label={`Progress for ${handoff.invoice_number}`}>
        {progressFor(handoff).map((step) => <li key={step.label} data-state={step.state} aria-current={step.state === 'current' ? 'step' : undefined}><i aria-hidden="true" /><span>{step.label}</span></li>)}
      </ol>
      <div className="partner-agent-state"><span>{modelCopy}</span>{handoff.outcome.delivery === 'failed' && <span className="partner-inline-error">Delivery failed</span>}</div>
      {handoff.result_reason && <p className="partner-result-reason">{handoff.result_reason}</p>}
      {legacyCorrectionBlocked && <p className="partner-result-reason">This historical handoff cannot be corrected because its input source was not recorded.</p>}
      {handoff.acknowledgment && (
        <div className="partner-acknowledgment" role="status">
          <strong>{handoff.acknowledgment.outcome === 'invoice_draft_saved' ? 'Finance saved the invoice draft' : 'Finance declined the invoice'}</strong>
          <span>{handoff.acknowledgment.finance_reviewer_display} · {new Date(handoff.acknowledgment.recorded_at).toLocaleString()}</span>
          <small>Acknowledgment {handoff.acknowledgment.delivery_status}. Finance notes and private conversation were not shared.</small>
        </div>
      )}
      <footer>
        <Button small onClick={showEvidence} aria-expanded={expanded}>{expanded ? 'Hide evidence' : 'View checks and evidence'}</Button>
        {handoff.request_id && workflow.actions.view_finance_review && <Button small primary onClick={() => { adapter.ensure('request', handoff.request_id!, true); nav(REQ(handoff.request_id!)); }}>Open Finance decision</Button>}
        {canCorrect && <Button small primary onClick={onCorrect}>Correct invoice</Button>}
        {workflow.viewer_role === 'finance' && handoff.finance_session_id && <a className="btn small" href={`/workspace/${state.workspace.id}/s/${handoff.finance_session_id}`}>Open Finance session</a>}
        {workflow.viewer_role === 'partnerships' && handoff.source_session_id && <a className="btn small" href={`/workspace/${state.workspace.id}/s/${handoff.source_session_id}`}>Open source session</a>}
      </footer>
      {expanded && (
        <div className="partner-handoff-evidence">
          {handoff.checks.length > 0 && <ul>{handoff.checks.map((check) => <li key={check.code} data-state={check.status}><strong>{check.code.replaceAll('_', ' ')}</strong><span>{check.message}</span></li>)}</ul>}
          {!result && <p className="meta">Loading authorized source excerpts…</p>}
          {result && <><p className="meta"><InputProvenanceBadge value={result.input_provenance} /> applies to this result and both authorized source snapshots.</p><div className="partner-evidence-grid"><EvidenceSource title="Authorized engagement source" source={result.source_versions.engagement} /><EvidenceSource title="Confirmed invoice source" source={result.source_versions.invoice} /></div></>}
        </div>
      )}
    </article>
  );
}

function EvidenceSource({ title, source }: { title: string; source: PartnerHandoffResult['source_versions']['engagement'] }) {
  return (
    <section>
      <span className="partner-card-kicker">{title}</span>
      <h4>{source.name}</h4>
      <p className="meta">{source.author_name ? `${source.author_name} · ` : ''}{new Date(source.created_at).toLocaleString()}</p>
      <blockquote>{source.excerpt}</blockquote>
    </section>
  );
}

export function PartnerWorkflow() {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const [workflow, setWorkflow] = useState<PartnerWorkflowViewV2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'setup' | 'engagement' | 'invoice' | null>(null);
  const [correction, setCorrection] = useState<PartnerWorkflowHandoffV2 | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [admissionBusy, setAdmissionBusy] = useState(false);
  const lastStreamMessage = state.connection.workspace.lastMessageAt;

  const load = (): void => {
    setError(null);
    void adapter.rest.partnerWorkflow(state.workspace.id)
      .then(setWorkflow)
      .catch((caught: unknown) => setError(workflowError(caught)))
      .finally(() => setLoading(false));
  };

  useEffect(load, [adapter.rest, state.workspace.id]);
  useEffect(() => {
    if (!lastStreamMessage) return;
    const timer = window.setTimeout(load, 140);
    return () => window.clearTimeout(timer);
  }, [lastStreamMessage]);

  const currentHandoffs = useMemo(() => workflow?.handoffs.filter((handoff) => handoff.current) ?? [], [workflow]);
  if (loading) return <Skeleton rows={4} label="Loading Partnerships and Finance" />;
  if (error || !workflow) return <div className="error-block"><span className="t">Could not load Partnerships + Finance</span><span className="s">{error}</span><Button small onClick={load}>Try again</Button></div>;

  const proposalSaved = (requestId: string, inputProvenance: PartnerInputProvenance): void => {
    setForm(null);
    setNotice(inputProvenance === 'sample' ? 'Sample engagement proposal created for demonstration. It does not confirm an external agreement.' : 'Engagement proposal created. Finance must authorize the recorded terms before an invoice can be submitted.');
    adapter.ensure('request', requestId, true);
    nav(REQ(requestId));
    load();
  };
  const invoiceSaved = (handoffId: string): void => {
    setForm(null);
    setCorrection(null);
    setNotice(correction ? 'Correction submitted. The original review remains in history.' : 'Invoice received. Partnerships and Finance activity will update here.');
    load();
    const target = document.getElementById(`handoff-${handoffId}`);
    target?.scrollIntoView({ block: 'nearest' });
  };
  const profilesReady = workflow.readiness.length === 2 && workflow.readiness.every((item) => item.configured && item.assignment_state === 'active' && item.native_status === 'ready' && item.missing.length === 0);
  const updateAdmission = (): void => {
    const enabled = workflow.admission_state !== 'enabled';
    setAdmissionBusy(true);
    setError(null);
    void adapter.rest.setPartnerWorkflowAdmission(state.workspace.id, { enabled })
      .then((view) => {
        setWorkflow(view);
        setNotice(enabled ? 'Partnerships + Finance is enabled for new governed work.' : 'New governed work is disabled. Existing records and receipts remain available.');
      })
      .catch((caught: unknown) => setError(workflowError(caught)))
      .finally(() => setAdmissionBusy(false));
  };

  return (
    <section className="partner-workflow" aria-labelledby="partner-workflow-title">
      <div className="partner-workflow-route" aria-label="Current workflow location"><span>Library</span><span aria-hidden="true">/</span><strong>Partnerships + Finance workflow</strong></div>
      <header className="partner-workflow-heading">
        <div><h2 id="partner-workflow-title">Partnerships + Finance</h2><p>One governed handoff. Private team context stays private; only authorized terms, confirmed invoice fields, and the final acknowledgment cross teams.</p></div>
        <div className="partner-heading-status"><span className="pill">{workflow.viewer_role === 'unrelated' ? 'No workflow access' : `${workflow.viewer_role[0]!.toUpperCase()}${workflow.viewer_role.slice(1)} view`}</span>{workflow.viewer_role !== 'unrelated' && <span className={`pill ${workflow.admission_state === 'enabled' ? 'pill-ok' : 'pill-warn'}`}>Workflow {workflow.admission_state}</span>}</div>
      </header>
      {workflow.viewer_role !== 'unrelated' && <div className="partner-role-grid">{workflow.readiness.map((item) => <RoleReadinessCard key={item.role} readiness={item} workflow={workflow} />)}</div>}
      <div className="partner-connector"><strong>Enterprise partner records</strong><span>{workflow.connector.summary}</span><small>Server enforced · exact record grants · private sessions are not shared</small></div>
      {workflow.viewer_role === 'unrelated' ? (
        <EmptyState icon="context" title="No Partnerships or Finance work assigned" detail="Your workspace membership does not grant access to these private handoffs." />
      ) : (
        <>
          <div className="partner-actions">
            <div><h3>Work in this role</h3><p>{workflow.viewer_role === 'admin' ? 'You can inspect setup readiness. Admin setup authority does not reveal private workflow content.' : workflow.viewer_role === 'finance' ? 'Review authorized evidence and record the human decision in Inbox.' : 'Record agreed terms, then submit the received invoice with fields you verified.'}</p></div>
            {workflow.actions.configure && <Button onClick={() => { setCorrection(null); setForm(form === 'setup' ? null : 'setup'); }}>{form === 'setup' ? 'Close setup' : workflow.configured ? 'Edit role bindings' : 'Configure roles'}</Button>}
            {workflow.actions.set_admission && <Button primary={workflow.admission_state !== 'enabled'} disabled={admissionBusy || (workflow.admission_state !== 'enabled' && !profilesReady)} onClick={updateAdmission}>{admissionBusy ? 'Saving…' : workflow.admission_state === 'enabled' ? 'Disable workflow' : 'Enable workflow'}</Button>}
            {workflow.actions.propose_engagement && <Button onClick={() => { setCorrection(null); setForm(form === 'engagement' ? null : 'engagement'); }}>{form === 'engagement' ? 'Close terms form' : 'Record agreed terms'}</Button>}
            {workflow.actions.submit_invoice && <Button primary onClick={() => { setCorrection(null); setForm(form === 'invoice' ? null : 'invoice'); }}>{form === 'invoice' && !correction ? 'Close invoice form' : 'Submit invoice to Finance'}</Button>}
          </div>
          <AnimatePresence initial={false}>
            {form === 'setup' && <WorkflowSetupForm key="setup" onClose={() => setForm(null)} onSaved={(view) => { setWorkflow(view); setForm(null); setNotice('Role assignments saved. Native readiness is shown above.'); }} />}
            {form === 'engagement' && <EngagementForm key="engagement" workflow={workflow} onClose={() => setForm(null)} onSaved={proposalSaved} />}
            {form === 'invoice' && <InvoiceForm key={correction?.id ?? 'invoice'} workflow={workflow} correction={correction} onClose={() => { setForm(null); setCorrection(null); }} onSaved={invoiceSaved} />}
          </AnimatePresence>
          {notice && <div className="partner-notice" role="status"><span>{notice}</span><Button small onClick={() => setNotice(null)}>Dismiss</Button></div>}
          {workflow.engagements.length > 0 && (
            <details className="partner-engagements">
              <summary>Authorized engagement terms ({workflow.engagements.length})</summary>
              <div>{workflow.engagements.map((engagement) => <article key={engagement.id}><div><strong>{engagement.partner.name}</strong><span>{engagement.reference} · {engagement.purpose}</span></div><div><strong>{money(engagement.authorized_total_minor, engagement.currency)}</strong><span>{engagement.authorization_status} · through {engagement.valid_until} · <InputProvenanceBadge value={engagement.input_provenance} /></span></div></article>)}</div>
            </details>
          )}
          <div className="partner-work-list">
            <header><h3>Invoice handoffs</h3><span className="meta">{currentHandoffs.length} current</span></header>
            {workflow.handoffs.length === 0 ? <EmptyState icon="invoice" title="No invoices handed to Finance yet" detail="A confirmed invoice appears here after Partnerships submits it." /> : workflow.handoffs.map((handoff) => <div id={`handoff-${handoff.id}`} key={handoff.id}><HandoffCard handoff={handoff} workflow={workflow} onCorrect={() => { setCorrection(handoff); setForm('invoice'); }} /></div>)}
          </div>
        </>
      )}
    </section>
  );
}
