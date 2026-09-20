import { expect, it } from 'vitest';
import { RestError } from '../../model/rest.js';
import { sourceUploadError } from './source-upload-error.js';

it('distinguishes unavailable storage from a bad user file without printing server details',()=>{
  const message=sourceUploadError(new RestError(503,'uploads_unavailable','PRIVATE_SERVER_DETAIL'));
  expect(message).toContain('storage is not configured');
  expect(message).not.toContain('PRIVATE_SERVER_DETAIL');
});
it('keeps unknown upload failures safe',()=>{
  expect(sourceUploadError(new Error('private presigned URL'))).toContain('Could not upload this source');
  expect(sourceUploadError(null)).not.toContain('private');
});
