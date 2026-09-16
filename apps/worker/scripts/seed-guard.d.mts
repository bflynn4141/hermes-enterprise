export interface SeedTarget {
  readonly display: string;
  readonly local: boolean;
  readonly test: boolean;
}

export function inspectSeedTarget(connectionString: string): SeedTarget;
export function assertSeedTargetAllowed(
  connectionString: string,
  override: string | undefined,
): SeedTarget & { readonly exceptionalOverride: boolean };
