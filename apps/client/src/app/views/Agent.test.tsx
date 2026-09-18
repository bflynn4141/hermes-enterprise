import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TraceFailure } from './Agent.js';

describe('trace failure detail', () => {
  it('renders retryable failures with the safe retry guidance', () => {
    const html = renderToStaticMarkup(<TraceFailure error={{
      class: 'transient', retryable: true, reason: 'hermes_provider_rate_limited',
      message: 'The selected model is rate limited. Wait a moment, then retry.', step_id: 'hermes',
    }} />);
    expect(html).toContain('Run failed · Safe to retry');
    expect(html).toContain('The selected model is rate limited. Wait a moment, then retry.');
    expect(html).toContain('role="status"');
  });

  it('renders non-retryable failures as requiring action', () => {
    const html = renderToStaticMarkup(<TraceFailure error={{
      class: 'auth', retryable: false, reason: 'hermes_provider_auth',
      message: 'The selected model connection needs attention. Reconnect it before retrying.', step_id: 'hermes',
    }} />);
    expect(html).toContain('Run failed · Action required');
    expect(html).toContain('Reconnect it before retrying.');
  });
});
