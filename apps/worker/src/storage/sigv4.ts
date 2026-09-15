// Presigned URLs for R2's S3-compatible API, signed with Web Crypto.
//
// Why sign at all when the Worker holds an R2 binding: because 20 MB of bytes
// should go from the browser to R2 directly. A Worker request has a body limit
// and a CPU budget, and proxying uploads spends both on moving bytes we are not
// reading. A presigned PUT costs one signature and no bandwidth.
//
// Why by hand rather than aws4fetch: the signature is about eighty lines of
// HMAC and the repository pins every dependency to an exact version and asks
// for a reason in docs/DECISIONS.md before adding one (decision U3). The
// alternative is a dependency in the deploy bundle whose job is to concatenate
// strings in the right order.
//
// This is query-string signing (SigV4 "presigned URL"), which puts the whole
// authorisation in the URL and therefore needs no headers from the client
// beyond `Host`. The payload is UNSIGNED-PAYLOAD, which is what presigning
// means: the signer does not have the bytes.
//
// Nothing here logs a URL. A presigned URL is a bearer credential for one
// object for fifteen minutes, and the redaction test names it by shape.

const encoder = new TextEncoder();

/** The service R2 emulates, and the region every R2 bucket reports. */
const SERVICE = 's3';
const REGION = 'auto';
const ALGORITHM = 'AWS4-HMAC-SHA256';

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes as ArrayBuffer));
}

/**
 * RFC 3986 encoding, which is stricter than `encodeURIComponent`.
 *
 * `!'()*` are legal in a URI and `encodeURIComponent` leaves them alone; SigV4
 * requires them encoded, and a key containing an apostrophe would otherwise
 * sign one string and be sent as another — a 403 that only some filenames get.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A key is a path: each segment is encoded, the separators are not. */
const encodeKey = (key: string): string => key.split('/').map(encodeRfc3986).join('/');

/** `20260914T120000Z` and `20260914`, the two forms SigV4 wants. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface PresignOptions {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly key: string;
  readonly method: 'PUT' | 'GET' | 'HEAD' | 'DELETE';
  /** Seconds. R2 and S3 both cap this at seven days. */
  readonly expiresIn: number;
  readonly now?: Date;
  /** Extra query parameters, e.g. `response-content-disposition` for a viewer. */
  readonly query?: Readonly<Record<string, string>>;
}

export interface Presigned {
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * A presigned URL for one object and one method.
 *
 * The signature covers the method, the path, every query parameter and the
 * `Host` header, so a URL minted for a PUT cannot be replayed as a DELETE and a
 * URL minted for one key cannot be pointed at another.
 */
export async function presign(options: PresignOptions): Promise<Presigned> {
  const now = options.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const host = `${options.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeRfc3986(options.bucket)}/${encodeKey(options.key)}`;
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  const parameters: Record<string, string> = {
    ...options.query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${options.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(options.expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  // Sorted by key, byte order. S3 rejects any other order, and the sort is the
  // reason this cannot be a template string.
  const canonicalQuery = Object.keys(parameters)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(parameters[name] ?? '')}`)
    .join('&');

  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  let key: ArrayBuffer | Uint8Array = encoder.encode(`AWS4${options.secretAccessKey}`);
  for (const part of [dateStamp, REGION, SERVICE, 'aws4_request']) key = await hmac(key, part);
  const signature = toHex(await hmac(key, stringToSign));

  return {
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + options.expiresIn * 1000),
  };
}
