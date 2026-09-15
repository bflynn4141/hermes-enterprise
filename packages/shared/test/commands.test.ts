import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_MODEL_NAME_PATTERN,
  HUMAN_ONLY_COMMANDS,
  MODEL_COMMANDS,
  findForbiddenNames,
  isHumanOnlyCommand,
  isModelCommand,
  validateModelBlocks,
} from '../src/index.js';

describe('command registries', () => {
  it('keeps the two registries disjoint', () => {
    const overlap = MODEL_COMMANDS.filter((name) => (HUMAN_ONLY_COMMANDS as readonly string[]).includes(name));
    expect(overlap).toEqual([]);
  });

  it('fails the build if a model command is ever named after a human action', () => {
    expect(findForbiddenNames([...MODEL_COMMANDS])).toEqual([]);
    // The guard itself has to work, or the assertion above proves nothing.
    expect(findForbiddenNames(['send_email', 'nav'])).toEqual([
      { name: 'send_email', reason: 'name matches a human-only action' },
    ]);
    expect(FORBIDDEN_MODEL_NAME_PATTERN.test('request/decide')).toBe(true);
    expect(FORBIDDEN_MODEL_NAME_PATTERN.test('set_focus')).toBe(false);
  });

  it('classifies both spellings of a human-only command', () => {
    expect(isHumanOnlyCommand('request/decide')).toBe(true);
    expect(isHumanOnlyCommand('decide')).toBe(true);
    expect(isModelCommand('nav')).toBe(true);
    expect(isModelCommand('decide')).toBe(false);
  });
});

describe('block validator', () => {
  it('accepts a model block that only navigates', () => {
    const result = validateModelBlocks([
      {
        type: 'card',
        title: 'Leah Martinez',
        action: { label: 'Open request', command: { type: 'open_request', id: 'req-1' } },
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it('rejects a confirm block that carries a decide command', () => {
    const result = validateModelBlocks([
      {
        type: 'confirm',
        title: 'Looks good?',
        options: [
          { label: 'Yes, admit her', command: { type: 'request/decide', id: 'leah', decision: 'approve' } },
          { label: 'Not yet', command: { type: 'nav', object: { section: 'inbox', view: 'list' } } },
        ],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.command).toBe('request/decide');
    expect(result.rejections[0]?.reason).toContain('human-only');
  });

  it('walks a nested batch, so one layer of wrapping is not a bypass', () => {
    const result = validateModelBlocks([
      {
        type: 'draft',
        actions: [
          {
            label: 'Do it',
            command: {
              type: 'batch',
              commands: [
                { type: 'nav', object: { section: 'inbox', view: 'list' } },
                { type: 'batch', commands: [{ type: 'effect/execute', id: 'eff-1' }] },
              ],
            },
          },
        ],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejections.map((r) => r.command)).toEqual(['effect/execute']);
  });

  it('rejects an unregistered command even when it sounds harmless', () => {
    const result = validateModelBlocks([{ type: 'choice', command: { type: 'workspace/rename' } }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejections[0]?.reason).toContain('unregistered');
  });

  it('rejects input that is not a block array at all', () => {
    expect(validateModelBlocks({ type: 'card' }).ok).toBe(false);
    expect(validateModelBlocks([{ type: 'not-a-block' }]).ok).toBe(false);
  });
});

describe('apply_prepared_proposal is a human-only command', () => {
  it('is not in MODEL_COMMANDS, so no model-authored block can carry it', () => {
    expect(MODEL_COMMANDS as readonly string[]).not.toContain('apply_prepared_proposal');
    expect(HUMAN_ONLY_COMMANDS as readonly string[]).toContain('apply_prepared_proposal');
    expect(isModelCommand('apply_prepared_proposal')).toBe(false);
    expect(isHumanOnlyCommand('apply_prepared_proposal')).toBe(true);
  });

  it('is rejected with the human-only reason, not the unregistered one', () => {
    // It matters which reason: "unregistered" would read as a typo in a log,
    // and this is the button that rewrites the agent's standing instructions on
    // one unreviewed click (security review O3).
    const result = validateModelBlocks([
      {
        type: 'plan',
        title: 'Ready to apply',
        action: { label: 'Continue', command: { type: 'apply_prepared_proposal', id: 'v1' } },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejections[0]?.reason).toContain('human-only');
  });

  it('is rejected inside a nested batch too', () => {
    const result = validateModelBlocks([
      {
        type: 'confirm',
        action: {
          label: 'Looks good',
          command: {
            type: 'batch',
            commands: [{ type: 'batch', commands: [{ type: 'apply_prepared_proposal', id: 'v1' }] }],
          },
        },
      },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe('the strings inside a block are model-authored too', () => {
  const markup = [
    ['a bidirectional override in a label', { type: 'choice', options: [{ label: 'Open ‮document', command: { type: 'nav' } }] }],
    ['a markdown link in a title', { type: 'note', title: 'See [the policy](http://evil.example)' }],
    ['an HTML tag in a subtitle', { type: 'note', subtitle: 'Hello <img src=x onerror=alert(1)>' }],
    ['an autolink in an action label', { type: 'draft', actions: [{ label: '<http://evil.example>', command: { type: 'nav' } }] }],
  ] as const;

  for (const [name, block] of markup) {
    it(`rejects ${name}`, () => {
      // These three fields skipped the plain-text validator entirely (security
      // review O8), so the visible label need not have been the stored one.
      expect(validateModelBlocks([block]).ok).toBe(false);
    });
  }

  it('still accepts an ordinary label with a bare URL in it', () => {
    const result = validateModelBlocks([
      { type: 'sources', title: 'From https://example.com/programme', subtitle: 'Read at 10:04' },
      { type: 'choice', options: [{ label: 'Open the document', command: { type: 'nav' } }] },
    ]);
    expect(result.ok).toBe(true);
  });
});
