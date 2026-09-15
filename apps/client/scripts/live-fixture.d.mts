// Types for the live fixture, which is plain ESM so that `apps/client` needs no
// database dependency to run its own end-to-end suite.
export declare const DATABASE: string;
export declare function psql(sql: string): string;
export declare function refreshStepUp(): void;
export declare function freshWorkspace(name?: string): {
  workspaceId: string;
  adminId: string;
  memberId: string;
  agentId: string;
  adminEmail: string;
  memberEmail: string;
  name: string;
};
