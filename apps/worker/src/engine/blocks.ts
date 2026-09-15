// Model-authored blocks: how they arrive, and what stops the dangerous ones.
//
// A provider stream carries text. A block is how the model asks the app to
// render something interactive — a choice, a confirm, a draft with actions —
// and it arrives inside the text as one fenced region:
//
//     ```hermes-blocks
//     [ { "type": "choice", "options": [...] } ]
//     ```
//
// The fence is stripped from what the human reads and the JSON goes through the
// shared block validator, which rejects any block carrying a command outside
// MODEL_COMMANDS. That is layer three of invariant 2: the decision route is
// already guarded, but a human clicking a button the model labelled "Looks
// good" that carries `decide` is a real click with manufactured consent. The
// block is dropped before it is ever rendered, and the rejection is logged.
import { validateModelBlocks, type Block, type BlockRejection } from '@hermes/shared';

const FENCE = /```hermes-blocks\s*\n([\s\S]*?)```/g;

export interface ExtractedBlocks {
  /** The text with every block fence removed. */
  readonly text: string;
  readonly blocks: readonly Block[];
  readonly rejections: readonly BlockRejection[];
}

export function extractBlocks(raw: string): ExtractedBlocks {
  const blocks: Block[] = [];
  const rejections: BlockRejection[] = [];
  const text = raw.replace(FENCE, (_match, body: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch (error) {
      rejections.push({
        blockIndex: -1,
        blockType: 'unknown',
        command: '',
        reason: `block fence is not JSON: ${(error as Error).message}`,
      });
      return '';
    }
    const result = validateModelBlocks(Array.isArray(parsed) ? parsed : [parsed]);
    if (result.ok) blocks.push(...result.blocks);
    else rejections.push(...result.rejections);
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), blocks, rejections };
}
