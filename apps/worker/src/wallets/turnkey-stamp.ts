// Turnkey API request signing ("stamping") on the Worker's WebCrypto.
//
// Turnkey authenticates every API call with an `X-Stamp` header: base64url JSON
// of the caller's compressed P-256 public key, the scheme, and a hex DER ECDSA
// SHA-256 signature over the exact request body. This mirrors
// @turnkey/api-key-stamper's WebCrypto path without its dependency tree.

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('Invalid hex');
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}
const bytesToHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const bigintToBytes = (value: bigint) => hexToBytes(value.toString(16).padStart(64, '0'));

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

/** Decompresses a 33-byte P-256 public key into JWK coordinates. */
export function decompressP256(compressedHex: string): { x: string; y: string } {
  const bytes = hexToBytes(compressedHex);
  if (bytes.length !== 33 || (bytes[0] !== 2 && bytes[0] !== 3)) throw new Error('Expected a compressed P-256 public key');
  const x = BigInt(`0x${bytesToHex(bytes.subarray(1))}`);
  if (x >= P) throw new Error('Invalid P-256 point');
  const rhs = (modPow(x, 3n, P) - 3n * x + B + 3n * P) % P;
  // P ≡ 3 (mod 4), so a square root is rhs^((P+1)/4).
  let y = modPow(rhs, (P + 1n) / 4n, P);
  if ((y * y) % P !== rhs) throw new Error('Invalid P-256 point');
  if ((y & 1n) !== BigInt(bytes[0]! & 1)) y = P - y;
  return { x: base64url(bigintToBytes(x)), y: base64url(bigintToBytes(y)) };
}

function trimInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  if (trimmed[0]! & 0x80) {
    const padded = new Uint8Array(trimmed.length + 1);
    padded.set(trimmed, 1);
    return padded;
  }
  return trimmed;
}

/** Converts WebCrypto's IEEE P1363 (r||s) ECDSA signature to DER. */
export function p1363ToDer(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error('Expected a 64-byte P-256 signature');
  const r = trimInteger(signature.subarray(0, 32));
  const s = trimInteger(signature.subarray(32));
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s];
  return Uint8Array.from([0x30, body.length, ...body]);
}

export type TurnkeyApiKey = { publicKey: string; privateKey: string };

export async function stampRequest(body: string, key: TurnkeyApiKey): Promise<{ name: 'X-Stamp'; value: string }> {
  const { x, y } = decompressP256(key.publicKey);
  const d = base64url(hexToBytes(key.privateKey.padStart(64, '0')));
  const cryptoKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, d, ext: false },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cryptoKey, new TextEncoder().encode(body)));
  const stamp = { publicKey: key.publicKey, scheme: 'SIGNATURE_SCHEME_TK_API_P256', signature: bytesToHex(p1363ToDer(signature)) };
  return { name: 'X-Stamp', value: base64url(new TextEncoder().encode(JSON.stringify(stamp))) };
}
