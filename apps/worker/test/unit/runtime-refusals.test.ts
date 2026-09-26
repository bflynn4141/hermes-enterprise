import { describe, expect, it } from 'vitest';
import { modelVisibleRefusal } from '../../src/runtime/bridge.js';
import { RouteError } from '../../src/routes/errors.js';

describe('runtime tool refusals the model can read', () => {
  it('turns correctable refusals into a failed tool result that names the reason', () => {
    for (const reason of ['runtime_tool_forbidden', 'runtime_run_waiting', 'runtime_call_conflict']) {
      expect(modelVisibleRefusal(new RouteError('Explained.', reason, 409), 'save_review_note'))
        .toEqual({ ok: false, content: `Explained. (${reason})` });
    }
  });

  it('keeps the statuses the plugin and the run lifecycle depend on', () => {
    for (const reason of ['mapping_pending', 'runtime_run_inactive', 'bad_body', 'unauthorized']) {
      expect(modelVisibleRefusal(new RouteError('Kept.', reason, 409), 'save_review_note')).toBeNull();
    }
  });

  it('answers an unexpected server error with guidance and none of its text', () => {
    const reply = modelVisibleRefusal(new Error('invalid input syntax for type uuid: "fc41d240"'), 'save_review_note');
    expect(reply).toMatchObject({ ok: false });
    const content = (reply as { content: string }).content;
    expect(content).toContain('save_review_note');
    expect(content).toContain('nothing was saved');
    expect(content).not.toContain('fc41d240');
  });
});
