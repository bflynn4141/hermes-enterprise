import { describe, expect, it } from 'vitest';
import { dataPrivacySchema } from '../src/index.js';

const KEY = '11111111-1111-4111-8111-111111111111';

describe('dataPrivacySchema', () => {
  it('requires server-owned policy facts beside retention and residency', () => {
    const parsed = dataPrivacySchema.parse({
      policy: [
        { id: 'model_training', label: 'Model training', value: 'Off' },
        { id: 'jurisdiction', label: 'Jurisdiction', value: 'eu' },
      ],
      keys: [{
        key_id: KEY,
        provider: 'anthropic',
        label: 'Production',
        last4: 'abcd',
        status: 'verified',
        verified_at: null,
        attestation: null,
        attested: false,
        warnings: [],
        real_data_allowed: false,
      }],
      retention: [{ store: 'Logs', retention: '7 days', erasure: 'expires' }],
      erasure: {
        tombstone: 'immediate',
        point_in_time_history_days: 7,
        backup_retention_days: 30,
        complete_after_days: 30,
        copy: 'Erasure completes after backup expiry.',
      },
      residency: {
        identity_provider: 'WorkOS',
        database: 'Neon region',
        objects: 'R2',
        processing: 'Workers',
      },
    });
    expect(parsed.policy.map((fact) => fact.id)).toEqual(['model_training', 'jurisdiction']);
  });

  it('rejects a payload that omits policy facts', () => {
    expect(dataPrivacySchema.safeParse({
      keys: [],
      retention: [],
      erasure: {
        tombstone: 'immediate',
        point_in_time_history_days: 7,
        backup_retention_days: 30,
        complete_after_days: 30,
        copy: 'Erasure completes after backup expiry.',
      },
      residency: {
        identity_provider: 'WorkOS',
        database: 'Neon region',
        objects: 'R2',
        processing: 'Workers',
      },
    }).success).toBe(false);
  });
});
