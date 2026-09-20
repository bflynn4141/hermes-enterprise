import { RestError } from '../../model/rest.js';

export function sourceUploadError(error: unknown): string {
  if (error instanceof RestError && error.reason === 'uploads_unavailable') {
    return 'Source uploads are unavailable because storage is not configured. Contact your workspace administrator.';
  }
  return 'Could not upload this source. Use a PDF, Markdown or text file up to 20 MB, and try again.';
}
