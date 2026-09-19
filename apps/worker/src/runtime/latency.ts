// Relative, content-free timings. Each Workflow invocation owns its clock;
// replayed checkpoints must never masquerade as freshly measured work.
export type RuntimeLatencyPhase =
  | 'workflow_setup' | 'startup_read' | 'startup_event_persistence' | 'startup_delivery'
  | 'submit_capabilities' | 'submit_preparation'
  | 'native_submit' | 'native_binding' | 'execute_capabilities'
  | 'execute_persistence' | 'execute_delivery'
  | 'stream_subscribe_started' | 'first_delta' | 'first_preview' | 'first_checkpoint';

export interface RuntimeLatency {
  phase: RuntimeLatencyPhase;
  duration_ms: number;
  elapsed_ms: number;
  /** Server turn receipt to this phase; absent for older/noninteractive runs. */
  turn_elapsed_ms: number | null;
}

export function runtimeLatency(
  startedAt: number,
  receivedAt: number | undefined,
  report?: (measurement: RuntimeLatency) => void,
) {
  const mark = (phase: RuntimeLatencyPhase, phaseStartedAt = startedAt) => {
    const now = Date.now();
    try {
      report?.({
        phase,
        duration_ms: Math.max(0, now - phaseStartedAt),
        elapsed_ms: Math.max(0, now - startedAt),
        turn_elapsed_ms: receivedAt === undefined ? null : Math.max(0, now - receivedAt),
      });
    } catch { /* An unavailable metrics sink cannot fail execution. */ }
  };
  return {
    mark,
    async measure<T>(phase: RuntimeLatencyPhase, work: () => Promise<T>): Promise<T> {
      const began = Date.now();
      try { return await work(); }
      finally { mark(phase, began); }
    },
  };
}
