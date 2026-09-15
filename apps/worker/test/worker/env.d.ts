// Types for the `cloudflare:test` module the Workers pool injects.
declare module 'cloudflare:test' {
  import type { Env as WorkerEnv } from '../../src/env.js';
  export const env: WorkerEnv;
  export const SELF: { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
}
