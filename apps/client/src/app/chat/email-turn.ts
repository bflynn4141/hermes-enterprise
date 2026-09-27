import type { Message } from '@hermes/shared';

/**
 * A received email as the conversation shows it: who wrote and about what.
 * New turns carry this as a card block (kind `email`); turns stored before
 * that carried the agent's instructions as their text, so those are read for
 * their From and Subject lines only and never shown whole.
 */
export function emailTurn(message: Pick<Message, 'kind' | 'text' | 'blocks'>): { from: string; subject: string } | null {
  if (message.kind === 'email') {
    const card = message.blocks.find((block) => block.type === 'card');
    return { from: card?.title ?? 'Someone', subject: card?.subtitle ?? message.text };
  }
  if (message.kind !== null || !/^A new email arrived at the .+ inbox \(/u.test(message.text)) return null;
  const from = /^- From: (.+?), (?:a member|a known contact|a first-time sender)/mu.exec(message.text)?.[1] ?? 'Someone';
  const subject = /^Subject: (.*)$/mu.exec(message.text)?.[1] ?? '(no subject)';
  return { from, subject };
}
