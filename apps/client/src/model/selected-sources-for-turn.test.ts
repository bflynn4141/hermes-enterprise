import { describe, expect, it } from 'vitest';
import { mockUuid } from '@hermes/shared';
import { selectedSourcesForTurn } from './rest.js';

describe('selectedSourcesForTurn', () => {
  it('keeps only hash-bound source chips that captureContext can load', () => {
    expect(selectedSourcesForTurn([
      { id: mockUuid(1), label: 'notes.pdf', kind: 'file', status: 'ready' },
      { id: mockUuid(2), label: 'Rubric.md', kind: 'source', status: 'ready', sha256: 'a'.repeat(64) },
      { id: mockUuid(3), label: 'Guide', kind: 'source', status: 'ready', sha256: 'b'.repeat(64), source_kind: 'library_source' },
      { id: mockUuid(4), label: 'pending', kind: 'source', status: 'ready' },
    ])).toEqual([
      { id: mockUuid(2), sha256: 'a'.repeat(64), kind: 'agent_file' },
      { id: mockUuid(3), sha256: 'b'.repeat(64), kind: 'library_source' },
    ]);
  });
});
