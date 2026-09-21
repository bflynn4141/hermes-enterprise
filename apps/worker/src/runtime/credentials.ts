import { RouteError } from '../routes/errors.js';

const TOKEN = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export function runtimeBearer(authorization: string | null): string | null {
  const token = /^Bearer ([0-9a-f]{64})$/.exec(authorization ?? '')?.[1] ?? null;
  return token && TOKEN.test(token) ? token : null;
}

export function newRuntimeBearer(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Scope the stored digest so the same bearer cannot be replayed for another
 * workspace or permanent preflight identity. */
export async function runtimeCredentialDigest(
  workspaceId: string,
  agentId: string,
  token: string,
): Promise<Uint8Array> {
  if (!TOKEN.test(token)) throw new RouteError('Invalid runtime credential.', 'runtime_unauthorized', 403);
  return new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`hermes/runtime-credential/v1:${workspaceId}:${agentId}:${token}`),
  ));
}

function bytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  return null;
}

/** Fixed-length XOR comparison. Both inputs are always traversed completely. */
export function constantTimeDigestEqual(left: unknown, right: Uint8Array): boolean {
  const candidate = bytes(left) ?? new Uint8Array(32);
  let difference = candidate.length ^ right.length;
  for (let index = 0; index < 32; index += 1) {
    difference |= (candidate[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function requireDigestBearer(
  storedDigest: unknown,
  workspaceId: string,
  agentId: string,
  authorization: string | null,
): Promise<void> {
  const token = runtimeBearer(authorization);
  const candidate = await runtimeCredentialDigest(workspaceId, agentId, token ?? '0'.repeat(64));
  if (!token || !constantTimeDigestEqual(storedDigest, candidate)) {
    throw new RouteError('Invalid runtime credential.', 'runtime_unauthorized', 403);
  }
}
