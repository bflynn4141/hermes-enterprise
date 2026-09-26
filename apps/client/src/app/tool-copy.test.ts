import { describe, expect, it } from 'vitest';
import { readableEntityType, readableModel, readableRef, readableRunStatus, readableStep, readableStepState, readableTool, readableWaitingLabel, runErrorSentence } from './tool-copy.js';

describe('tool copy', () => {
  it('translates a known tool and falls back to plain words for an unknown one', () => {
    expect(readableTool('get_document_text', true)).toBe('Reading a source document');
    expect(readableTool('get_document_text', false)).toBe('Read a source document');
    expect(readableTool('partner_record_read', false)).toBe('Used partner record read');
  });

  it('keys the error sentence off the reason before the provider message', () => {
    expect(runErrorSentence({ reason: 'hermes_unavailable', message: 'ECONNREFUSED 10.0.0.4:8642' })).toBe('The Hermes runtime is unavailable. Retry to reconnect.');
    expect(runErrorSentence({ reason: 'hermes_runtime_not_ready', message: 'Hermes request failed (503 native_readiness_unavailable)' })).toBe("This agent's runtime didn't pass its safety check. If retrying doesn't help, an admin needs to update it.");
    expect(runErrorSentence({ reason: 'provider_5xx', message: 'The provider returned 503.' })).toBe("The model provider didn't answer. Retry.");
    expect(runErrorSentence({ reason: 'something_new', message: 'A message a human wrote.' })).toBe('A message a human wrote.');
    expect(runErrorSentence(null)).toBe('Error');
  });

  it('names run and step states in plain words and passes prose through', () => {
    expect(readableRunStatus('waiting')).toBe('Needs you');
    expect(readableRunStatus('error')).toBe('Failed');
    expect(readableRunStatus('Awaiting review')).toBe('Awaiting review');
    expect(readableStepState('active')).toBe('In progress');
    expect(readableStep({ label: 'get_request', state: 'done', tool_call_id: 'c1' })).toBe('Reviewed a request');
    expect(readableStep({ label: 'Thinking', state: 'active', tool_call_id: null })).toBe('Thinking');
  });

  it('turns the engine\'s approval wait into a sentence and keeps a human label as is', () => {
    expect(readableWaitingLabel('Approve propose_approval in Permissions')).toBe('Waiting for your approval · Preparing an approval');
    expect(readableWaitingLabel('Feedback destination')).toBe('Feedback destination');
    expect(readableWaitingLabel(null)).toBeNull();
  });

  it('resolves a model id through the catalog and otherwise trims it to its name', () => {
    const catalog = [{ model_id: 'nous:anthropic/claude-sonnet-5', label: 'Anthropic: Claude Sonnet 5' }];
    expect(readableModel('nous:anthropic/claude-sonnet-5', catalog)).toBe('Anthropic: Claude Sonnet 5');
    expect(readableModel('nous:deepseek/deepseek-v4.1-flash', catalog)).toBe('deepseek-v4.1-flash');
    expect(readableModel(null, catalog)).toBe('Model not recorded');
  });

  it('names a focus ref without its id', () => {
    expect(readableRef({ section: 'inbox', view: 'request' })).toBe('Inbox · Request');
    expect(readableRef({ section: 'agents', view: 'traces', sub: 'compare' })).toBe('Agent · Runs · Compare');
    expect(readableEntityType('request')).toBe('A request');
  });
});
