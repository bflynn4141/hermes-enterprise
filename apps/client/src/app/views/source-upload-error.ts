import { RestError } from '../../model/rest.js';

export function sourceUploadError(error: unknown): string {
  if (error instanceof RestError && error.reason === 'uploads_unavailable') {
    return 'File uploads aren’t turned on for this Hermes yet. Ask your workspace admin.';
  }
  return 'Could not upload this source. Use a PDF, Markdown or text file up to 20 MB, and try again.';
}
