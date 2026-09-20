import type { Client } from 'pg';
export interface Migration { filename: string; sql: string; sha: string }
export function loadMigrations(): Promise<Migration[]>;
export function applyMigrations(client: Client, migrations: Migration[], options: { allowEdit?: boolean; force?: boolean }): Promise<number>;
export function fingerprint(client: Client): Promise<string>;
