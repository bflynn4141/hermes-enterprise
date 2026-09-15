// Two command registries and the block validator that keeps them apart.
//
// A model-authored block (a choice, a confirm, a draft's actions, a plan's
// action) may carry a command. MODEL_COMMANDS is the entire set it may carry.
// HUMAN_ONLY_COMMANDS are rendered only by the Inbox review pane and the
// receipt, from server data, and reach the server through the guarded decision
// route with its own headers, CSRF token and step-up.
//
// Why a validator and not just a guarded endpoint: the endpoint was already
// guarded. The risk this closes is different — a human clicking a button the
// model labelled "Looks good" that carries `decide`. The click is real, the
// consent is not. So the block is rejected before it is ever rendered.
import { z } from 'zod';
import { refSchema } from './refs.js';

/**
 * Everything a model-authored block may ask the app to do. Every entry moves
 * the view or applies something a human already prepared; none of them changes
 * a request, a member, money or an outbound message.
 */
export const MODEL_COMMANDS = [
  'nav',
  'set_focus',
  'open_request',
  'open_document',
  'open_source',
  'apply_prepared_proposal',
  'chat/say',
  // Puts text in the composer as the human's next turn. Named `prompt`, not
  // `send`: nothing this registry contains may send anything outside the app,
  // and the forbidden-name test enforces that by reading the names.
  'chat/prompt',
  'batch',
] as const;
export type ModelCommandName = (typeof MODEL_COMMANDS)[number];

/**
 * Commands only a human surface may issue. Both spellings are listed: the
 * canonical product name and the demo's dispatch name, because a scripted
 * provider that learned the demo vocabulary would otherwise slip through.
 */
export const HUMAN_ONLY_COMMANDS = [
  'decide',
  'request/decide',
  'execute_effect',
  'effect/execute',
  'invite',
  'member/invite',
  'member/remove',
  'member/resend',
  'member/reinvite',
  'role',
  'member/role',
  'settings',
  'settings/set',
  'provider_key/add',
  'provider_key/revoke',
  'workspace/delete',
  'document/version',
  'share/create',
  'share/revoke',
] as const;
export type HumanOnlyCommandName = (typeof HUMAN_ONLY_COMMANDS)[number];

const MODEL_SET: ReadonlySet<string> = new Set<string>(MODEL_COMMANDS);
const HUMAN_SET: ReadonlySet<string> = new Set<string>(HUMAN_ONLY_COMMANDS);

export const isModelCommand = (name: string): name is ModelCommandName => MODEL_SET.has(name);
export const isHumanOnlyCommand = (name: string): name is HumanOnlyCommandName => HUMAN_SET.has(name);

/**
 * Names that must never appear in MODEL_COMMANDS or in a tool registry. A
 * build-time test runs this over both registries: if someone adds a
 * `send_email` tool in a year's time, CI fails before the model ever sees it.
 */
export const FORBIDDEN_MODEL_NAME_PATTERN =
  /(^|[._/-])(decide|decision|approve|admit|send|email|pay|payment|sign|signature|grant|invite|role|execute|transfer|charge)([._/-]|$)/i;

export interface RegistryViolation {
  readonly name: string;
  readonly reason: string;
}

/** Returns the entries of a registry that look like an action a human owns. */
export function findForbiddenNames(names: readonly string[]): RegistryViolation[] {
  const violations: RegistryViolation[] = [];
  for (const name of names) {
    if (FORBIDDEN_MODEL_NAME_PATTERN.test(name)) {
      violations.push({ name, reason: 'name matches a human-only action' });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * A command as it appears inside a block. `type` is validated by the block
 * validator, not by zod, so that a rejected command produces a useful reason
 * ("carries the human-only command request/decide") rather than a union error.
 */
export const blockCommandSchema = z.looseObject({
  type: z.string().min(1).max(64),
  object: refSchema.optional(),
  id: z.string().min(1).max(128).optional(),
  text: z.string().max(4000).optional(),
  // A `batch` command carries children; zod 4 expresses the recursion with a getter.
  get commands() {
    return z.array(blockCommandSchema).max(10).optional();
  },
});

export type BlockCommand = {
  type: string;
  object?: z.infer<typeof refSchema>;
  id?: string;
  text?: string;
  commands?: BlockCommand[];
  [key: string]: unknown;
};

const blockActionSchema = z
  .object({
    label: z.string().min(1).max(120),
    command: blockCommandSchema,
    tone: z.enum(['default', 'primary', 'quiet']).optional(),
  })
  .strict();

/**
 * The block kinds a model may author. Read-only kinds (`sources`, `card`,
 * `run-steps`) carry no command; the interactive kinds carry commands the
 * validator checks.
 */
export const BLOCK_TYPES = [
  'card',
  'sources',
  'run-steps',
  'people',
  'note',
  'error',
  'stopped',
  'guidance',
  'receipt',
  'choice',
  'confirm',
  'draft',
  'plan',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const blockSchema = z.looseObject({
  type: z.enum(BLOCK_TYPES),
  title: z.string().max(300).optional(),
  subtitle: z.string().max(600).optional(),
  action: blockActionSchema.optional(),
  actions: z.array(blockActionSchema).max(6).optional(),
  command: blockCommandSchema.optional(),
  options: z
    .array(z.object({ label: z.string().min(1).max(120), command: blockCommandSchema }).strict())
    .max(6)
    .optional(),
});

export type Block = z.infer<typeof blockSchema>;

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

export interface BlockRejection {
  readonly blockIndex: number;
  readonly blockType: string;
  readonly command: string;
  readonly reason: string;
}

export type BlockValidation =
  | { readonly ok: true; readonly blocks: readonly Block[] }
  | { readonly ok: false; readonly rejections: readonly BlockRejection[] };

function commandsIn(block: Block): BlockCommand[] {
  const found: BlockCommand[] = [];
  const push = (c: unknown): void => {
    if (!c || typeof c !== 'object') return;
    const cmd = c as BlockCommand;
    found.push(cmd);
    if (Array.isArray(cmd.commands)) for (const nested of cmd.commands) push(nested);
  };
  push(block.command);
  push(block.action?.command);
  for (const a of block.actions ?? []) push(a.command);
  for (const o of block.options ?? []) push(o.command);
  return found;
}

/**
 * Validate model-authored blocks. Every command inside every block must be in
 * MODEL_COMMANDS; a nested `batch` is walked, because otherwise one layer of
 * nesting would be a bypass. A rejection is a log line and a dropped block,
 * never a rendered button.
 */
export function validateModelBlocks(input: unknown): BlockValidation {
  const parsed = z.array(blockSchema).max(20).safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      rejections: [{ blockIndex: -1, blockType: 'unknown', command: '', reason: `block schema: ${parsed.error.message}` }],
    };
  }
  const rejections: BlockRejection[] = [];
  parsed.data.forEach((block, blockIndex) => {
    for (const cmd of commandsIn(block)) {
      if (isModelCommand(cmd.type)) continue;
      rejections.push({
        blockIndex,
        blockType: block.type,
        command: cmd.type,
        reason: isHumanOnlyCommand(cmd.type)
          ? `carries the human-only command ${cmd.type}; only the Inbox review pane may render it`
          : `carries the unregistered command ${cmd.type}`,
      });
    }
  });
  return rejections.length === 0 ? { ok: true, blocks: parsed.data } : { ok: false, rejections };
}
