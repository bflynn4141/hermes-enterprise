import { describe, expect, it } from 'vitest';
import { RestError, plainRestMessage } from '../../model/rest.js';
import { readableFields, readableText } from './fields.js';
import { modelName, providerName, vendorName } from './names.js';

describe('names', () => {
  it('uses brand names, never slugs', () => {
    expect(providerName('nous_portal')).toBe('Nous Portal');
    expect(vendorName('meta-llama')).toBe('Meta');
    expect(modelName('nous:anthropic/claude-sonnet-5')).toBe('Claude Sonnet 5');
    expect(modelName('nous:stepfun/step-3.7-flash:free')).toBe('Step 3.7 Flash');
    expect(modelName('nous:openai/gpt-5.5')).toBe('GPT 5.5');
    expect(modelName('x', [{ model_id: 'x', label: 'Label from the catalog' }])).toBe('Label from the catalog');
  });
});

describe('readable fields', () => {
  it('labels values in words and leaves identifiers and JSON out', () => {
    const fields = readableFields({
      request_id: '00000000-0000-4000-8000-000000000001',
      summary: 'Evidence is incomplete.',
      to_address: 'priya@example.com',
      draft_only: true,
      recipients: [{ name: 'Priya Raman', id: 'abc' }],
      nested: { score: 82 },
    });
    expect(fields).toEqual([
      { label: 'Summary', value: 'Evidence is incomplete.' },
      { label: 'To address', value: 'priya@example.com' },
      { label: 'Draft only', value: 'Yes' },
      { label: 'Recipients', value: 'Name: Priya Raman' },
      { label: 'Nested', value: 'Score: 82' },
    ]);
    expect(fields.map((field) => `${field.label} ${field.value}`).join(' ')).not.toMatch(/[{}]|request_id|0000-4000/);
  });

  it('shows plain text as text and JSON as fields', () => {
    expect(readableText('{"status":"awaiting"}')).toEqual({ fields: [{ label: 'Status', value: 'awaiting' }], text: null });
    expect(readableText('A page of text')).toEqual({ fields: [], text: 'A page of text' });
    expect(readableText(null)).toEqual({ fields: [], text: null });
  });
});

describe('rest error messages', () => {
  it('never carries the method, path, status line or the server text on message', () => {
    const message = plainRestMessage(409, 'run_in_flight');
    expect(message).not.toMatch(/POST|\/w\/|409|run_in_flight/);
    expect(plainRestMessage(422, 'contract_violation')).toMatch(/couldn’t read/);
    const error = new RestError(429, 'rate_limited', plainRestMessage(429, 'rate_limited'), null, null, 'run.turn is limited to 30 per 60 seconds');
    expect(error.message).not.toContain('run.turn');
    expect(error.detail).toContain('run.turn');
  });
});
