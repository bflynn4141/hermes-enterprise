// Poll until an agent_file's extracted text is ready for captureContext.
//
// `completeUpload` only confirms stored bytes. Iris reads extracted text, so
// the composer must wait for extraction_status === 'ready' and a sha256 before
// attaching a source chip.
import type { AttachmentDetail } from '@hermes/shared';

export class AgentFileExtractionError extends Error {
  constructor(
    message: string,
    readonly detail?: AttachmentDetail,
  ) {
    super(message);
    this.name = 'AgentFileExtractionError';
  }
}

export async function waitForAgentFileReady(
  getUpload: () => Promise<AttachmentDetail>,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    intervalMs?: number;
    maxAttempts?: number;
  } = {},
): Promise<AttachmentDetail> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = opts.intervalMs ?? 1500;
  const maxAttempts = opts.maxAttempts ?? 40;
  let last: AttachmentDetail | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    last = await getUpload();
    if (last.status === 'ready' && last.extraction_status === 'ready' && last.sha256) return last;
    if (last.extraction_status === 'failed' || last.status === 'failed') {
      throw new AgentFileExtractionError(
        last.extraction_error?.trim()
          || 'Source processing failed. Upload a corrected PDF, Markdown, or text file and try again.',
        last,
      );
    }
    if (attempt + 1 < maxAttempts) await sleep(intervalMs);
  }
  throw new AgentFileExtractionError('Source is still processing. Try again in a moment.', last);
}
