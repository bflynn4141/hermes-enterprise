/** Cloudflare's documented instance-id pattern. */
export const WORKFLOW_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9\-_]*$/;
export const WORKFLOW_ID_MAX_LENGTH = 100;

/** Deterministic id for one run attempt, kept dependency-free for job runners. */
export function runAttemptInstanceId(runId: string, attempt: number): string {
  const id = `${runId}-a${attempt}`;
  if (!WORKFLOW_ID_PATTERN.test(id) || id.length > WORKFLOW_ID_MAX_LENGTH) {
    throw new Error(`run attempt id is not a valid Workflow instance id: ${id}`);
  }
  return id;
}
