/**
 * Requests a Finance reviewer, not only an Admin, may decide: the partner
 * invoice handoff and the contractor agreement created on admit.
 *
 * Keyed on the subject key, never the payload. Only server code writes these
 * prefixes (an agent's `propose_request` gets `email:`, `name:` or
 * `partner-candidate:`; see engine/tools.ts `subjectKeyFor`), while an agent
 * can put anything, including `workflow_provenance`, in a payload.
 */
export const FINANCE_DECIDABLE_SQL = `(
  (r.kind='invoice' AND r.subject_key LIKE 'partner-invoice-handoff:%')
  OR (r.kind='agreement' AND r.subject_key LIKE 'partner-contractor-agreement:%')
)`;

export const financeWorkflowRequest = (row: { kind: string; subject_key?: string | null }): boolean =>
  (row.kind === 'invoice' && !!row.subject_key?.startsWith('partner-invoice-handoff:'))
  || (row.kind === 'agreement' && !!row.subject_key?.startsWith('partner-contractor-agreement:'));
