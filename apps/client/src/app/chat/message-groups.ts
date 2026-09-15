import type { Message } from '@hermes/shared';

/** A provider turn can be durable without being a response to the person. */
const isProviderTurn = (message: Message): boolean =>
  message.role === 'iris' && Boolean(message.run_id) && (message.kind == null || message.kind === 'progress');

export const hasVisibleMessageContent = (message: Message): boolean =>
  Boolean(message.heading?.trim() || message.text.trim() || message.blocks.length > 0 || message.incomplete);

function withWorkedTotal(message: Message, messages: readonly Message[], totalWorkedMs?: number | null): Message {
  if (totalWorkedMs != null) return { ...message, worked_ms: totalWorkedMs };
  const durations = messages.map((item) => item.worked_ms).filter((value): value is number => value != null);
  return durations.length > 0 ? { ...message, worked_ms: durations.reduce((sum, value) => sum + value, 0) } : message;
}

/**
 * A run may call the model several times around tools. Only its last visible
 * provider turn is the answer; the earlier turns are progress for the one
 * activity surface above it.
 */
export function partitionRunMessages(
  messages: readonly Message[],
  settled: boolean,
  totalWorkedMs?: number | null,
): { progress: Message[]; answer: Message | null } {
  const providerTurns = messages.filter(isProviderTurn);
  if (!settled) return { progress: providerTurns.filter(hasVisibleMessageContent), answer: null };

  let answerIndex = -1;
  for (let index = providerTurns.length - 1; index >= 0; index -= 1) {
    if (hasVisibleMessageContent(providerTurns[index]!)) {
      answerIndex = index;
      break;
    }
  }
  if (answerIndex === -1) return { progress: [], answer: null };

  const answer = withWorkedTotal(providerTurns[answerIndex]!, providerTurns, totalWorkedMs);
  return {
    progress: providerTurns.slice(0, answerIndex).filter(hasVisibleMessageContent),
    answer,
  };
}

/**
 * Once another question starts, the run object no longer owns the old rows.
 * Collapse each contiguous provider-turn group so reloads and session switches
 * keep the same one-answer shape as the live run.
 */
export function collapseHistoricalMessages(messages: readonly Message[]): Message[] {
  const collapsed: Message[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (!isProviderTurn(message)) {
      collapsed.push(message);
      index += 1;
      continue;
    }

    const runId = message.run_id;
    const group: Message[] = [];
    while (index < messages.length) {
      const candidate = messages[index]!;
      if (!isProviderTurn(candidate) || candidate.run_id !== runId) break;
      group.push(candidate);
      index += 1;
    }
    const { answer } = partitionRunMessages(group, true);
    if (answer) collapsed.push(answer);
  }
  return collapsed;
}
