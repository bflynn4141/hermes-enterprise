// The R2 access layer.
//
// Two ways in, for two different jobs:
//
//   * the binding (`env.UPLOADS`) for everything the Worker does itself —
//     reading an object back to hash it, writing extracted text, deleting on
//     erasure. No credential, no signature, no egress.
//   * a presigned URL (see sigv4.ts) for everything the *browser* does, so the
//     bytes never pass through a Worker request.
//
// The fallback matters for local development. `wrangler dev --local` simulates
// R2 on disk with no account and therefore no S3 credentials, so there is
// nothing to sign with. Rather than making local uploads impossible or making
// the client special-case it, the route hands back a dev-only direct-upload URL
// on this Worker and says `direct: true`. That route refuses to exist outside
// development, which is the only thing keeping a convenience from becoming an
// unsigned upload endpoint in production.
import { canPresign, type Env } from '../env.js';
import { presign, type Presigned } from './sigv4.js';

export class StorageError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export function bucket(env: Env): R2Bucket {
  if (!env.UPLOADS) throw new StorageError('the UPLOADS bucket is not bound', 'no_bucket');
  return env.UPLOADS;
}

export const getObject = (env: Env, key: string): Promise<R2ObjectBody | null> => bucket(env).get(key);

export const headObject = (env: Env, key: string): Promise<R2Object | null> => bucket(env).head(key);

export const putObject = (
  env: Env,
  key: string,
  body: ReadableStream | ArrayBuffer | string,
  options?: R2PutOptions,
): Promise<R2Object | null> => bucket(env).put(key, body, options);

export const deleteObject = (env: Env, key: string | string[]): Promise<void> => bucket(env).delete(key);

/** Every key under a prefix, paged. R2 lists 1000 at a time. */
export async function listPrefix(env: Env, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket(env).list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

/**
 * Delete everything under a prefix.
 *
 * R2's `delete` takes at most 1000 keys per call, so the list is chunked. The
 * count returned is what the erasure record says it deleted, and an erasure
 * that claims a number it did not delete is worse than one that failed.
 */
export async function deletePrefix(env: Env, prefix: string): Promise<number> {
  const objects = await listPrefix(env, prefix);
  for (let i = 0; i < objects.length; i += 1000) {
    await deleteObject(
      env,
      objects.slice(i, i + 1000).map((o) => o.key),
    );
  }
  return objects.length;
}

/** Can this environment hand the browser an R2 URL at all? */
export const presigningAvailable = (env: Env): boolean => canPresign(env);

function credentials(env: Env): { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string } {
  if (!canPresign(env)) {
    throw new StorageError('R2 S3 credentials are not configured', 'no_s3_credentials');
  }
  return {
    accountId: env.R2_ACCOUNT_ID as string,
    accessKeyId: env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
    bucket: env.R2_BUCKET,
  };
}

/** A presigned PUT for one key. Fifteen minutes, from the plan. */
export const presignPut = (env: Env, key: string, expiresIn: number, now?: Date): Promise<Presigned> =>
  presign({ ...credentials(env), key, method: 'PUT', expiresIn, ...(now ? { now } : {}) });

/**
 * A presigned GET for the viewer.
 *
 * `response-content-disposition` is signed along with everything else, so the
 * browser renders the file inline under its real name instead of downloading
 * `1f3c…-uuid`. It also means a URL minted for one filename cannot be re-pointed
 * at another without invalidating the signature.
 */
export function presignGet(env: Env, key: string, expiresIn: number, filename?: string, now?: Date): Promise<Presigned> {
  return presign({
    ...credentials(env),
    key,
    method: 'GET',
    expiresIn,
    ...(now ? { now } : {}),
    ...(filename
      ? { query: { 'response-content-disposition': `inline; filename="${filename.replace(/["\\]/g, '')}"` } }
      : {}),
  });
}
