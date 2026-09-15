// Configuration the run engine depends on, asserted where drift is cheap to
// catch: the step options, the scripted-provider switch, and the constants that
// carry a number from the production plan.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WAIT_TIMEOUT,
  DEFAULT_MAX_TURNS,
  DELTA_BATCH_MS,
  DOCUMENT_TEXT_MAX_TOKENS,
  ORPHAN_NO_EVENT_MINUTES,
  PROVIDER_STEP_RETRY_LIMIT,
  PROVIDER_STEP_TIMEOUT,
  SUBREQUEST_ALARM_FRACTION,
  SUBREQUEST_BUDGET,
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_RESULT_MAX_BYTES,
  TOOL_STEP_TIMEOUT,
  TURN_HISTORY_LIMIT,
} from '../../src/engine/constants.js';

function readWranglerConfig(): Record<string, unknown> {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../../wrangler.jsonc');
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
  return JSON.parse(text) as Record<string, unknown>;
}

const config = readWranglerConfig();
const envs = config.env as Record<string, Record<string, unknown>>;

describe('the scripted-provider switch', () => {
  it('is on in development, because a fresh checkout has no provider key', () => {
    expect((config.vars as Record<string, string>).MODEL_SCRIPTED).toBe('1');
    expect((config.vars as Record<string, string>).OPENROUTER_FIXTURE).toBe('1');
  });

  it('is absent from staging and production, in the config and not only in code', () => {
    for (const name of ['staging', 'production']) {
      const vars = envs[name]?.vars as Record<string, string> | undefined;
      expect(vars?.MODEL_SCRIPTED).toBeUndefined();
      // Same rule for the OpenRouter verification fixture: a deployed Worker
      // that answered `/key` from a canned 200 would mark every string an
      // Admin pasted as a verified key.
      expect(vars?.OPENROUTER_FIXTURE).toBeUndefined();
      // The environment name is what the code checks, so it has to be right.
      expect(vars?.ENVIRONMENT).toBe(name);
    }
  });
});

describe('the numbers the plan fixed', () => {
  it('keeps the step timeouts the plan chose over the documented defaults', () => {
    expect(PROVIDER_STEP_TIMEOUT).toBe('30 minutes');
    expect(PROVIDER_STEP_RETRY_LIMIT).toBe(3);
    expect(TOOL_STEP_TIMEOUT).toBe('2 minutes');
  });

  it('keeps the budget numbers', () => {
    expect(DELTA_BATCH_MS).toBe(500);
    expect(SUBREQUEST_BUDGET).toBe(10_000);
    expect(SUBREQUEST_ALARM_FRACTION).toBe(0.5);
    expect(DEFAULT_MAX_TURNS).toBe(12);
    expect(TURN_HISTORY_LIMIT).toBe(20);
  });

  it('keeps the tool limits', () => {
    expect(TOOL_RESULT_MAX_BYTES).toBe(8 * 1024);
    expect(TOOL_EXECUTION_TIMEOUT_MS).toBe(30_000);
    expect(DOCUMENT_TEXT_MAX_TOKENS).toBe(6_000);
  });

  it('keeps the waiting and sweep windows', () => {
    expect(CONTEXT_WAIT_TIMEOUT).toBe('30 days');
    expect(ORPHAN_NO_EVENT_MINUTES).toBe(10);
  });
});

/**
 * The subrequest estimate, written down so the alarm has something to alarm
 * about.
 *
 * What is counted: one SessionHub RPC per delta batch, one per non-delta emit,
 * and one provider fetch per provider step. The Postgres side is one Hyperdrive
 * connection held for the whole invocation rather than one per query, which is
 * why the arithmetic below is dominated by the hub.
 *
 * The plan's rejected figure is twelve 5-minute turns at one RPC per 250 ms,
 * which is 14,400 against a 10,000 default. Batching at 500 ms halves it.
 */
describe('the subrequest estimate', () => {
  const FIVE_MINUTES_MS = 300_000;
  const nonDeltaEmitsPerTurn = 4;

  it('is the plan\'s own arithmetic at the rate it rejected', () => {
    expect((FIVE_MINUTES_MS / 250) * DEFAULT_MAX_TURNS).toBe(14_400);
  });

  it('fits the budget for twelve five-minute turns once deltas are batched', () => {
    const perTurn = FIVE_MINUTES_MS / DELTA_BATCH_MS + nonDeltaEmitsPerTurn + 1;
    expect(perTurn * DEFAULT_MAX_TURNS).toBeLessThan(SUBREQUEST_BUDGET);
  });

  it('stays under the 50 percent alarm for a realistic 30-second turn', () => {
    const perTurn = 30_000 / DELTA_BATCH_MS + nonDeltaEmitsPerTurn + 1;
    expect(perTurn * DEFAULT_MAX_TURNS).toBeLessThan(SUBREQUEST_BUDGET * SUBREQUEST_ALARM_FRACTION);
  });
});
