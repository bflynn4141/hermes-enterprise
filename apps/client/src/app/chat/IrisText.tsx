// One place decides how a model-authored *chat* sentence is drawn.
//
// Two paths, and the split is the point (decision C39):
//
//   nothing to mark up   the plain `<span>` with `white-space: pre-wrap` the
//                        transcript has always used. An ordinary sentence keeps
//                        its exact typography and its exact line breaks, and no
//                        parser has any say over it.
//   structure            the safe subset, through `Markdown`.
//
// Used by the finished message and by the live stream, so a reply does not
// change shape when `message.final` replaces the accumulator with the same
// words — which it would if only one of the two rendered Markdown.
//
// This is chat prose only. Every string a *tool* writes — a review note, an
// instruction body, a proposal field — is still refused at the writer by
// `packages/shared/plain-text.ts` and still rendered as plain text by the
// screen that shows it. The two rules are about two different things: what an
// agent may put in a row a human will later be held to, and what an agent may
// put in a sentence it is saying now.
import { Markdown } from './Markdown.js';
import { hasMarkup } from './markdown-subset.js';

export function IrisText({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  if (!hasMarkup(text)) return <span className={className}>{text}</span>;
  return <Markdown text={text} className={className} />;
}
