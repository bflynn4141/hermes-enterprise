// See cloudflare-workers.ts: a stand-in for the Node test projects only.
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}
