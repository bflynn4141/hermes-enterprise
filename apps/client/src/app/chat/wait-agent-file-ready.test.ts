import { describe, expect, it, vi } from 'vitest';
import type { AttachmentDetail } from '@hermes/shared';
import { mockUuid } from '@hermes/shared';
import { AgentFileExtractionError, waitForAgentFileReady } from './wait-agent-file-ready.js';

function detail(patch: Partial<AttachmentDetail> = {}): AttachmentDetail {
  return {
    id: mockUuid(70),
    name: 'notes.txt',
    size: 12,
    mime: 'text/plain',
    sha256: 'a'.repeat(64),
    status: 'ready',
    kind: 'agent_file',
    extraction_status: 'ready',
    extraction_error: null,
    text_length: 12,
    token_estimate: 3,
    created_at: '2026-10-12T09:49:00.000Z',
    url: null,
    url_expires_at: null,
    ...patch,
  };
}

describe('waitForAgentFileReady', () => {
  it('returns once extraction is ready with a hash', async () => {
    const getUpload = vi.fn()
      .mockResolvedValueOnce(detail({ extraction_status: 'pending', sha256: null, text_length: null }))
      .mockResolvedValueOnce(detail());
    const sleep = vi.fn(async () => undefined);
    await expect(waitForAgentFileReady(getUpload, { sleep, intervalMs: 10 })).resolves.toMatchObject({
      extraction_status: 'ready',
      sha256: 'a'.repeat(64),
    });
    expect(getUpload).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('fails clearly when extraction fails', async () => {
    await expect(waitForAgentFileReady(async () => detail({
      extraction_status: 'failed',
      extraction_error: 'unsupported encoding',
      sha256: null,
    }), { sleep: async () => undefined })).rejects.toSatisfy((error: unknown) =>
      error instanceof AgentFileExtractionError && error.message.includes('unsupported encoding'));
  });

  it('gives up after max attempts while still pending', async () => {
    await expect(waitForAgentFileReady(async () => detail({ extraction_status: 'pending' }), {
      sleep: async () => undefined,
      maxAttempts: 2,
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof AgentFileExtractionError && error.message.includes('still processing'));
  });
});
