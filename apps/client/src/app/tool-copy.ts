interface ToolWords {
  active: string;
  complete: string;
}

/** Human wording for an exact runtime tool identifier. */
const TOOL_WORDS: Readonly<Record<string, ToolWords>> = {
  list_requests: { active: 'Checking the review queue', complete: 'Checked the review queue' },
  get_request: { active: 'Reviewing a request', complete: 'Reviewed a request' },
  get_approval_status: { active: 'Checking an approval', complete: 'Checked an approval' },
  get_document_text: { active: 'Reading a source document', complete: 'Read a source document' },
  get_workspace_context: { active: 'Reading workspace context', complete: 'Read workspace context' },
  get_history: { active: 'Reviewing recent activity', complete: 'Reviewed recent activity' },
  list_members: { active: 'Checking the team', complete: 'Checked the team' },
  fetch_url: { active: 'Reviewing an approved web source', complete: 'Reviewed an approved web source' },
  propose_request: { active: 'Preparing a review request', complete: 'Prepared a review request' },
  propose_approval: { active: 'Preparing an approval', complete: 'Prepared an approval' },
  save_review_note: { active: 'Saving a review note', complete: 'Saved a review note' },
  set_context_field: { active: 'Updating workspace context', complete: 'Updated workspace context' },
  propose_instruction: { active: 'Drafting an instruction update', complete: 'Drafted an instruction update' },
  ask_for_context: { active: 'Asking for missing context', complete: 'Asked for missing context' },
  set_focus: { active: 'Opening the relevant record', complete: 'Opened the relevant record' },
  list_partner_candidates: { active: 'Checking partner candidates', complete: 'Checked partner candidates' },
  get_partner_candidate: { active: 'Reviewing a partner candidate', complete: 'Reviewed a partner candidate' },
  web_search: { active: 'Searching the web', complete: 'Searched the web' },
  web_extract: { active: 'Reading a web page', complete: 'Read a web page' },
  terminal: { active: 'Running a command', complete: 'Ran a command' },
};

/** Keep the exact identifier visible beside this translation in audit UI. */
export function readableTool(name: string, active: boolean): string {
  const known = TOOL_WORDS[name.toLowerCase().replace(/\s+/g, '_')];
  if (known) return active ? known.active : known.complete;
  const words = name.replace(/[_-]+/g, ' ').trim();
  if (!words) return active ? 'Using a tool' : 'Used a tool';
  return `${active ? 'Using' : 'Used'} ${words}`;
}
