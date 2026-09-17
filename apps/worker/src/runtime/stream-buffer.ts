// One ordered, coalescing delivery lane. Reading native SSE never awaits this
// lane; finalization drains durable delivery and may discard stale previews.
export class StreamBuffer {
  private pending = '';
  private offset = 0;
  private lastFlush = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private draining = false;
  private discarded = false;
  failure: unknown = null;

  constructor(private readonly windowMs: number, private readonly send: (delta: string, offset: number) => Promise<void>) {}

  append(delta: string): void {
    if (this.discarded) return;
    this.pending += delta;
    this.flush();
  }

  flush(force = false): void {
    if (this.discarded || this.failure || this.inFlight || !this.pending) return;
    const remaining = this.windowMs - (Date.now() - this.lastFlush);
    if (!force && !this.draining && remaining > 0) {
      this.timer ??= setTimeout(() => { this.timer = null; this.flush(); }, remaining);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Both wire contracts accept this size. Preserve UTF-16 offsets without
    // splitting a surrogate pair across separately serialized JSON frames.
    let end = Math.min(this.pending.length, 32768);
    if (end < this.pending.length && /[\uD800-\uDBFF]/u.test(this.pending[end - 1]!)) end -= 1;
    const delta = this.pending.slice(0, end);
    const offset = this.offset;
    this.pending = this.pending.slice(end);
    this.offset += delta.length;
    this.lastFlush = Date.now();
    this.inFlight = Promise.resolve().then(() => this.discarded ? undefined : this.send(delta, offset))
      .catch((error: unknown) => { this.failure = error; })
      .finally(() => { this.inFlight = null; this.flush(); });
  }

  /** An in-flight RPC cannot be unsent, but no queued preview may follow it. */
  discard(): void {
    this.discarded = true;
    this.pending = '';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async drain(): Promise<void> {
    this.draining = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (!this.discarded && (this.pending || this.inFlight)) {
      if (this.failure) throw this.failure;
      this.flush(true);
      if (this.inFlight) await this.inFlight;
    }
    if (this.failure) throw this.failure;
  }
}
