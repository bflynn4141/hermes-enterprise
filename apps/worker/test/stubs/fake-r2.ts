// An R2 bucket in a Map.
//
// The `db` project runs the real Worker in Node against real Postgres (decision
// 8), which is what makes the tenant transaction, the grants and the routes the
// real ones — but Node has no R2. This stub implements exactly the surface
// `src/storage/r2.ts` uses, and no more: a stub that grew a method the code does
// not call would be a claim about R2 nobody checks.
//
// The real binding is exercised in the `worker` project, where Miniflare
// provides a local R2 for the same calls.
export interface FakeObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly uploaded: Date;
  readonly contentType: string | undefined;
}

export class FakeR2 {
  readonly objects = new Map<string, FakeObject>();
  /** Advanced by a test to make an object look old enough for the sweep. */
  now: () => Date = () => new Date();

  put(
    key: string,
    body: ArrayBuffer | Uint8Array | string | ReadableStream,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown> {
    return this.write(key, body, options?.httpMetadata?.contentType);
  }

  private async write(
    key: string,
    body: ArrayBuffer | Uint8Array | string | ReadableStream,
    contentType: string | undefined,
  ): Promise<unknown> {
    const bytes =
      typeof body === 'string'
        ? new TextEncoder().encode(body)
        : body instanceof Uint8Array
          ? body
          : body instanceof ArrayBuffer
            ? new Uint8Array(body)
            : new Uint8Array(await new Response(body).arrayBuffer());
    const object: FakeObject = { key, bytes, uploaded: this.now(), contentType };
    this.objects.set(key, object);
    return this.meta(object);
  }

  get(key: string): Promise<unknown> {
    const object = this.objects.get(key);
    if (!object) return Promise.resolve(null);
    return Promise.resolve({
      ...this.meta(object),
      arrayBuffer: () => Promise.resolve(object.bytes.slice().buffer),
      text: () => Promise.resolve(new TextDecoder().decode(object.bytes)),
      get body() {
        return new Response(object.bytes.slice()).body;
      },
    });
  }

  head(key: string): Promise<unknown> {
    const object = this.objects.get(key);
    return Promise.resolve(object ? this.meta(object) : null);
  }

  delete(key: string | string[]): Promise<void> {
    for (const one of Array.isArray(key) ? key : [key]) this.objects.delete(one);
    return Promise.resolve();
  }

  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<unknown> {
    const prefix = options?.prefix ?? '';
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    return Promise.resolve({
      objects: keys.map((key) => this.meta(this.objects.get(key) as FakeObject)),
      truncated: false,
      cursor: undefined,
    });
  }

  private meta(object: FakeObject): Record<string, unknown> {
    return {
      key: object.key,
      size: object.bytes.byteLength,
      // Not a real MD5: nothing in this repository compares an etag to one it
      // computed itself, only to one it stored.
      etag: `${object.bytes.byteLength}-${object.bytes[0] ?? 0}`,
      uploaded: object.uploaded,
      httpMetadata: { contentType: object.contentType },
      customMetadata: undefined,
    };
  }
}

/** A queue that records what was sent instead of sending it. */
export class FakeQueue {
  readonly sent: unknown[] = [];
  send(body: unknown): Promise<void> {
    this.sent.push(body);
    return Promise.resolve();
  }
  sendBatch(messages: { body: unknown }[]): Promise<void> {
    for (const message of messages) this.sent.push(message.body);
    return Promise.resolve();
  }
}

/** A batch the consumers can be handed directly, with ack and retry recorded. */
export function fakeBatch(
  queue: string,
  bodies: unknown[],
): { batch: MessageBatch<unknown>; acked: string[]; retried: string[] } {
  const acked: string[] = [];
  const retried: string[] = [];
  const messages = bodies.map((body, index) => ({
    id: `m${index}`,
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => acked.push(`m${index}`),
    retry: () => retried.push(`m${index}`),
  }));
  const batch = {
    queue,
    messages,
    ackAll: () => messages.forEach((_, i) => acked.push(`m${i}`)),
    retryAll: () => messages.forEach((_, i) => retried.push(`m${i}`)),
  } as unknown as MessageBatch<unknown>;
  return { batch, acked, retried };
}
