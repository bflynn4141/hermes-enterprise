export interface OwnedTestTarget {
  readonly ownerToken: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly host: string;
  readonly port: string;
  readonly database: string;
}

export interface InspectedTestContainer {
  readonly id: string;
  readonly name: string;
  readonly ownerToken: string;
  readonly running: boolean;
  readonly database: string;
  readonly host: string;
  readonly port: string;
}

export const DEV_DATABASE: string;
export let TEST_DATABASE: string;
export const OWNER_LABEL: string;
export const DATABASE_URL_KEYS: readonly string[];

export function ownedTargetEnvironment(target: OwnedTestTarget): Record<string, string>;
export function hyperdriveStrings(database?: string, env?: NodeJS.ProcessEnv): Record<string, string>;
export function isolatedTestEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function targetFromEnvironment(env?: NodeJS.ProcessEnv): OwnedTestTarget;
export function inspectContainer(containerId: string): InspectedTestContainer | null;
export function assertOwnedTestTarget(
  target: OwnedTestTarget,
  options?: { inspect?: (containerId: string) => InspectedTestContainer | null },
): OwnedTestTarget;
export function resolveVitestTarget(
  env?: NodeJS.ProcessEnv,
  options?: { needsDatabase?: boolean; inspect?: (containerId: string) => InspectedTestContainer | null },
): (OwnedTestTarget & { readonly github: false }) | {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly github: boolean;
};
export function cleanupOwnedTestTarget(
  target: OwnedTestTarget,
  options?: {
    inspect?: (containerId: string) => InspectedTestContainer | null;
    stop?: (containerId: string) => unknown;
  },
): { readonly removed: boolean; readonly alreadyAbsent: boolean };
export function ensureTestDatabase(options?: { seed?: boolean }): string;
export function cleanupTestDatabase(): { readonly removed: boolean; readonly alreadyAbsent: boolean };
export function psql(
  database: string,
  sql: string,
  options?: { quiet?: boolean },
): { readonly ok: boolean; readonly out: string; readonly err: string };
