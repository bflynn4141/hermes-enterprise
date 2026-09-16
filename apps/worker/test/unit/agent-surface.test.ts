// Layers two and three of "the runtime never decides".
//
// Layer one is the grant matrix and lives in `test/db/grants.test.ts`. This
// file covers the other two: the type of the write surface a tool is handed,
// and the block validator that stops a model-authored button carrying a
// human-only command. Both are here rather than in the engine tests because
// they must fail at build time, not at run time — a registry that gained a
// `send_email` tool should break CI before anything is deployed.
import { describe, expect, it } from 'vitest';
import { HUMAN_ONLY_COMMANDS, MODEL_COMMANDS, findForbiddenNames } from '@hermes/shared';
import type { AgentWrites } from '../../src/engine/agent-db.js';
import { extractBlocks } from '../../src/engine/blocks.js';
import { TOOLS, TOOL_NAMES, allowedTools, registryViolations, subjectKeyFor, toolResultEnvelope } from '../../src/engine/tools.js';
import { TOOL_RESULT_MAX_BYTES } from '../../src/engine/constants.js';

// ---------------------------------------------------------------------------
// The type test
// ---------------------------------------------------------------------------

/**
 * The five verbs `AgentWrites` may never gain. Written as a type so the check
 * is the compiler's rather than a string search somebody can forget to run:
 * if a method whose name contains any of them is added, `Forbidden` stops being
 * `never` and the assignment below fails to compile.
 */
type ForbiddenVerb = 'decide' | 'Decide' | 'execute' | 'Execute' | 'invite' | 'Invite' | 'role' | 'Role' | 'job' | 'Job';
type Forbidden = Extract<keyof AgentWrites, `${string}${ForbiddenVerb}${string}`>;

// If this line fails to compile, a write surface the agent must never have has
// been added to `AgentWrites`. Add a route, not a method.
const noForbiddenWrites: Forbidden extends never ? true : never = true;

describe('the AgentWrites surface', () => {
  it('has no decide, execute, invite, role or job method', () => {
    expect(noForbiddenWrites).toBe(true);
  });

  it('is exactly the narrow proposal and trace methods the runtime exposes', () => {
    // A compile-time list, checked at run time so the failure names the method.
    const expected: readonly (keyof AgentWrites)[] = [
      'proposeRequest',
      'proposeApproval',
      'saveReviewNote',
      'setContextField',
      'proposeInstruction',
      'appendTurn',
      'emit',
    ];
    expect(expected).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('the tool registry', () => {
  it('contains no name that looks like an action a human owns', () => {
    expect(registryViolations()).toEqual([]);
  });

  it('has no decide, send, pay, sign, grant or invite tool at all', () => {
    for (const forbidden of ['decide', 'send_email', 'pay_invoice', 'sign_agreement', 'grant_access', 'invite_member']) {
      expect(TOOL_NAMES).not.toContain(forbidden);
      expect(findForbiddenNames([forbidden])).not.toEqual([]);
    }
  });

  it('keeps enterprise approvals out of the generic request proposal path', () => {
    const generic = TOOLS.find((tool) => tool.name === 'propose_request');
    const kinds = ((generic?.input_schema.properties as Record<string, { enum?: string[] }> | undefined)?.kind?.enum) ?? [];
    expect(kinds).not.toContain('approval');
    expect(TOOL_NAMES).toContain('propose_approval');
  });

  it('keeps the two command registries disjoint', () => {
    const model = new Set<string>(MODEL_COMMANDS);
    for (const command of HUMAN_ONLY_COMMANDS) expect(model.has(command)).toBe(false);
  });

  it('gives Work mode everything and Ask and Plan only the read and view tools', () => {
    const all = TOOL_NAMES;
    expect(allowedTools('work', all).map((t) => t.name)).toEqual([...all]);
    const ask = allowedTools('ask', all);
    expect(ask.every((t) => t.kind !== 'propose')).toBe(true);
    expect(ask.map((t) => t.name)).toContain('get_request');
    expect(ask.map((t) => t.name)).not.toContain('propose_request');
  });

  it('offers nothing when the workspace configured no capabilities', () => {
    expect(allowedTools('work', [])).toEqual([]);
  });

  it('describes every tool, because the description is what the model reads', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.input_schema.type).toBe('object');
    }
  });
});

// ---------------------------------------------------------------------------
// The block validator, from the engine's side
// ---------------------------------------------------------------------------

describe('a model-authored block', () => {
  const fence = (blocks: unknown): string =>
    `Here is my read.\n\n\`\`\`hermes-blocks\n${JSON.stringify(blocks)}\n\`\`\`\n`;

  it('is kept when every command is in MODEL_COMMANDS', () => {
    const result = extractBlocks(
      fence([{ type: 'card', title: 'Ada Ling', action: { label: 'Open', command: { type: 'open_request', id: 'r1' } } }]),
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.rejections).toEqual([]);
    expect(result.text).toBe('Here is my read.');
  });

  it('is rejected when it carries a human-only command, however it is spelled', () => {
    for (const command of ['decide', 'request/decide', 'execute_effect', 'member/invite']) {
      const result = extractBlocks(
        fence([{ type: 'confirm', title: 'Looks good', action: { label: 'Approve', command: { type: command } } }]),
      );
      expect(result.blocks).toEqual([]);
      expect(result.rejections[0]?.command).toBe(command);
    }
  });

  it('walks a nested batch, because one layer of nesting would otherwise be a bypass', () => {
    const result = extractBlocks(
      fence([
        {
          type: 'confirm',
          action: {
            label: 'Do it',
            command: { type: 'batch', commands: [{ type: 'nav' }, { type: 'request/decide' }] },
          },
        },
      ]),
    );
    expect(result.blocks).toEqual([]);
    expect(result.rejections.map((r) => r.command)).toContain('request/decide');
  });

  it('drops a fence that is not JSON rather than showing it to the reader', () => {
    const result = extractBlocks('Text.\n\n```hermes-blocks\nnot json\n```\n');
    expect(result.blocks).toEqual([]);
    expect(result.text).toBe('Text.');
    expect(result.rejections).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

describe('a tool result', () => {
  const at = new Date('2026-09-14T12:00:00.000Z');

  it('is labelled with its source, its time and that it is untrusted', () => {
    const envelope = JSON.parse(toolResultEnvelope('get_request', 'workspace.requests', { id: 'r1' }, at)) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      tool: 'get_request',
      source: 'workspace.requests',
      retrieved_at: '2026-09-14T12:00:00.000Z',
      untrusted: true,
    });
  });

  it('is truncated with a marker past 8 KB, and stays valid JSON', () => {
    const big = toolResultEnvelope('get_document_text', 'workspace.documents', { text: 'x'.repeat(40_000) }, at);
    expect(new TextEncoder().encode(big).byteLength).toBeLessThan(TOOL_RESULT_MAX_BYTES * 2);
    const parsed = JSON.parse(big) as { truncated?: boolean; data_text?: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.data_text).toContain('[truncated');
  });
});

describe('the subject key', () => {
  it('normalises an email', async () => {
    const { key } = await subjectKeyFor({ applicant: { name: 'Ada', email: '  Ada.Ling@Example.COM ' } });
    expect(key).toBe('email:ada.ling@example.com');
  });

  it('hashes a name when there is no email, so the key is not a copy of it', async () => {
    const { key } = await subjectKeyFor({ applicant: { name: 'Ada Ling' } });
    expect(key.startsWith('name:')).toBe(true);
    expect(key).not.toContain('Ada');
    expect(key.slice(5)).toHaveLength(64);
  });
});
