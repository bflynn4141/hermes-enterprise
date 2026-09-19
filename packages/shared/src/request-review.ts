// Bind a legacy document decision to the request the reviewer actually read.
// The timestamp version alone cannot distinguish two edits in the same second.
import type { RequestKind } from './enums.js';

export interface RequestReviewBinding {
  readonly expected_version: number;
  readonly expected_payload_hash: `sha256:${string}`;
}

export interface ReviewableRequest {
  readonly id: string;
  readonly kind: RequestKind;
  readonly version: number;
  readonly payload: unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new TypeError('request review binding requires JSON data');
}

// Shared's types are platform neutral; these are the Web APIs supplied by the
// browser, Worker and Node runtimes without pulling DOM or Node globals in.
const web = globalThis as typeof globalThis & {
  TextEncoder: new () => { encode(value: string): Uint8Array<ArrayBuffer> };
  crypto: { subtle: { digest(algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> } };
};

export async function requestReviewBinding(request: ReviewableRequest): Promise<RequestReviewBinding> {
  const value = canonicalJson({ id: request.id, kind: request.kind, payload: request.payload });
  const digest = await web.crypto.subtle.digest('SHA-256', new web.TextEncoder().encode(value));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { expected_version: request.version, expected_payload_hash: `sha256:${hash}` };
}
