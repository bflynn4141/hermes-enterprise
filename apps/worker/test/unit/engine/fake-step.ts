// A `WorkflowStep` that runs in Node.
//
// It does the two things the real one does that the engine depends on:
// checkpoint a step's result under its name, and re-run the body on a retryable
// throw up to the configured limit. That is enough to exercise the whole tool
// loop, every failure class, Stop, waiting and the crash-mid-tool case without
// workerd and without a network — which is the point, because a failure
// taxonomy that can only be exercised inside a deployed runtime is a taxonomy
// nobody runs.
//
// What it does not model: real timers (a retry is immediate), real timeouts, and
// the durability of the checkpoint across a process restart. The first two are
// deliberate — a test that waits ten real seconds to prove a backoff is a test
// people delete — and the third is simulated by reusing the same store across
// two `runAttempt` calls.
import { NonRetryableError } from 'cloudflare:workflows';
import type { EngineStep, StepConfig } from '../../../src/engine/engine.js';

export interface RecordedStep {
  readonly name: string;
  readonly attempts: number;
  readonly ok: boolean;
}

export class FakeStep implements EngineStep {
  /** Checkpointed results, by step name. Survives across instances in a test. */
  readonly results = new Map<string, unknown>();
  readonly attempts = new Map<string, number>();
  readonly order: string[] = [];
  /** Events armed before the run, the way Workflows buffers early events. */
  private readonly armed = new Map<string, unknown>();
  /** Called just before each attempt of a named step; lets a test inject a crash. */
  beforeAttempt: ((name: string, attempt: number) => void | Promise<void>) | null = null;

  constructor(seed?: FakeStep) {
    if (seed) {
      for (const [k, v] of seed.results) this.results.set(k, v);
    }
  }

  arm(eventName: string, payload: unknown): void {
    this.armed.set(eventName, payload);
  }

  async do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T> {
    if (this.results.has(name)) return this.results.get(name) as T;
    this.order.push(name);
    let lastError: unknown = new Error(`step ${name} never ran`);
    const limit = Math.max(1, config.retries.limit);
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      this.attempts.set(name, attempt);
      try {
        if (this.beforeAttempt) await this.beforeAttempt(name, attempt);
        const result = await fn();
        this.results.set(name, result);
        return result;
      } catch (error) {
        // A permanent error is not retried: that is the whole meaning of
        // NonRetryableError, and a fake that retried it would make the
        // permanent classes untestable.
        if (error instanceof NonRetryableError) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /** Every `waitForEvent` this run made, with the options it passed. */
  readonly waits: { name: string; options: { type: string; timeout: string } }[] = [];

  waitForEvent<T>(name: string, options: { type: string; timeout: string }): Promise<{ payload: T }> {
    this.waits.push({ name, options });
    // The runtime matches a `sendEvent` on `options.type`, never on `name`, so
    // a fake that ignored `type` would pass for the code that omitted it — and
    // omitting it is exactly what left a parked run unwakeable (decision G8).
    if (!options.type) return Promise.reject(new Error(`waitForEvent(${name}) was given no event type`));
    if (!this.armed.has(name)) {
      return Promise.reject(new Error(`no ${name} event was armed; arm it before the run`));
    }
    const payload = this.armed.get(name) as T;
    this.armed.delete(name);
    return Promise.resolve({ payload });
  }
}
