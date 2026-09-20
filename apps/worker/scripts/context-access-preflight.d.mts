export interface ContextAccessRow {
  file_count: number | string;
  note_count: number | string;
  session_count: number | string;
  context_scope: string;
  owner_user_id?: string | null;
  owner_status?: string | null;
  principal_user_id?: string | null;
  principal_status?: string | null;
  other_session_owner?: boolean;
}
export function validateWorkspace(value: unknown): string;
export function disposition(row: ContextAccessRow): string;
export function checkContextAccess(client: {
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}, workspace: unknown): Promise<{ ok: boolean; counts: Record<string, number>; affected_agents: { agent_id: string; disposition: string }[] }>;
