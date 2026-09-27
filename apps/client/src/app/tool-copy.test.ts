import { describe, expect, it } from 'vitest';
import { readableEntityType, readableModel, readableRef, readableRunStatus, readableStep, readableStepState, readableTool, readableToolActions, readableWaitingLabel, runErrorSentence } from './tool-copy.js';

describe('tool copy', () => {
  it('translates a known tool and never shows an unknown tool by its id', () => {
    expect(readableTool('get_document_text', true)).toBe('Reading a source document');
    expect(readableTool('get_document_text', false)).toBe('Read a source document');
    expect(readableTool('suggest_reply', true)).toBe('Suggesting a reply');
    expect(readableTool('suggest_handoff', false)).toBe('Handed off to another team');
    expect(readableTool('partner_record_read', false)).toBe('Used a tool');
    expect(readableTool('partner_record_read', true)).toBe('Using a tool');
  });

  it('has words for every tool the engine registers', () => {
    const tools = ['ask_for_context', 'fetch_url', 'get_approval_status', 'get_document_text', 'get_history', 'get_partner_candidate',
      'get_partner_handoff_result', 'get_request', 'get_workspace_context', 'list_members', 'list_partner_candidates', 'list_requests',
      'propose_approval', 'propose_instruction', 'propose_request', 'publish_partner_invoice_review', 'save_review_note', 'set_context_field',
      'set_focus', 'suggest_handoff', 'suggest_reply', 'skill_view', 'mcp__agentcash__fetch'];
    for (const tool of tools) {
      expect(readableTool(tool, true)).not.toBe('Using a tool');
      expect(readableTool(tool, false)).not.toMatch(/_/);
    }
    expect(readableToolActions(['suggest_reply', 'mystery_tool', 'other_mystery'])).toEqual(['Suggest replies', 'Use another tool']);
  });

  it('keys the error sentence off the reason and never shows the server message', () => {
    expect(runErrorSentence({ reason: 'hermes_unavailable', message: 'ECONNREFUSED 10.0.0.4:8642' })).toBe("Hermes couldn't reach this agent. Retry in a moment.");
    expect(runErrorSentence({ reason: 'hermes_provider_rate_limited', message: 'The selected model is rate limited.' })).toBe('The model is busy right now. Try again in a minute.');
    expect(runErrorSentence({ reason: 'provider_5xx', message: 'The provider returned 503.' })).toBe("The model didn't answer. Retry in a moment.");
    expect(runErrorSentence({ reason: 'something_new', message: 'ECONNRESET upstream' })).toBe('The task stopped before it finished. Retry to try again.');
    expect(runErrorSentence(null)).toBe('Something went wrong.');
    for (const reason of ['hermes_runtime_not_ready', 'hermes_contract_violation', 'engine_version_changed', 'no_progress', 'instance_dead', 'tool_rejected', 'malformed_tool_json', 'key_invalid', 'unknown_model']) {
      expect(runErrorSentence({ reason, message: 'raw' })).not.toMatch(/runtime|raw|_/i);
    }
  });

  it('names run and step states in plain words and passes prose through', () => {
    expect(readableRunStatus('waiting')).toBe('Needs you');
    expect(readableRunStatus('error')).toBe('Failed');
    expect(readableRunStatus('Awaiting review')).toBe('Awaiting review');
    expect(readableRunStatus('changes_requested')).toBe('Changes requested');
    expect(readableStepState('active')).toBe('In progress');
    expect(readableStep({ label: 'get_request', state: 'done', tool_call_id: 'c1' })).toBe('Reviewed a request');
    expect(readableStep({ label: 'Thinking', state: 'active', tool_call_id: null })).toBe('Thinking');
  });

  it('turns the engine\'s approval wait into a sentence and keeps a human label as is', () => {
    expect(readableWaitingLabel('Approve propose_approval in Permissions')).toBe('Waiting for your approval · Preparing an approval');
    expect(readableWaitingLabel('Feedback destination')).toBe('Feedback destination');
    expect(readableWaitingLabel(null)).toBeNull();
  });

  it('resolves a model id through the catalog and otherwise reads it as a name', () => {
    const catalog = [{ model_id: 'nous:anthropic/claude-sonnet-5', label: 'Anthropic: Claude Sonnet 5' }];
    expect(readableModel('nous:anthropic/claude-sonnet-5', catalog)).toBe('Anthropic: Claude Sonnet 5');
    expect(readableModel('nous:deepseek/deepseek-v4.1-flash', catalog)).toBe('DeepSeek V4.1 Flash');
    expect(readableModel('nous:anthropic/claude-sonnet-5', [])).toBe('Claude Sonnet 5');
    expect(readableModel(null, catalog)).toBe('Model not recorded');
  });

  it('names a focus ref without its id', () => {
    expect(readableRef({ section: 'inbox', view: 'request' })).toBe('Inbox · Request');
    expect(readableRef({ section: 'agents', view: 'traces', sub: 'compare' })).toBe('Agent · Activity · Compare');
    expect(readableEntityType('request')).toBe('A request');
  });
});
