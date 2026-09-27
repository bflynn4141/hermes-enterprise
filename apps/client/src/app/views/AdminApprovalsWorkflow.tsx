// Admin → Approvals, third group: approvals a workflow raises with its own
// reviewer (decision C97). Read-only: the rows are plain list items with no
// control, because an Admin cannot route these yet and a button that opened
// nothing would say otherwise.
import { WORKFLOW_APPROVALS, type WorkflowApproval } from '@hermes/shared';
import './admin-approvals.css';

export const WORKFLOW_APPROVALS_TITLE = 'Built-in reviewers';
export const WORKFLOW_APPROVALS_NOTE = 'Hermes chooses who reviews these. They cannot be changed here yet.';

/** "Reviewed by the new member". */
export const workflowReviewerLine = (approval: Pick<WorkflowApproval, 'reviewer'>): string => `Reviewed by ${approval.reviewer}`;

export function AdminApprovalsWorkflow() {
  return <section className="admin-approvals-group" aria-label={WORKFLOW_APPROVALS_TITLE}>
    <header><h3>{WORKFLOW_APPROVALS_TITLE}</h3><p className="meta">{WORKFLOW_APPROVALS_NOTE}</p></header>
    <ul className="admin-roles-list" aria-label={WORKFLOW_APPROVALS_TITLE}>
      {WORKFLOW_APPROVALS.map((approval) => <li key={approval.key}>
        <div className="admin-roles-row admin-approvals-static">
          <span className="admin-roles-name">{approval.label}</span>
          <span className="admin-roles-description">{approval.description}</span>
          <span className="admin-approvals-rule">{workflowReviewerLine(approval)}</span>
        </div>
      </li>)}
    </ul>
  </section>;
}
