// Every secret the product uses has to be named in .dev.vars.example, because
// that file is the only documentation of what a new environment needs, and a
// secret nobody documented is a deploy that fails at the first request.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const example = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../.dev.vars.example'), 'utf8');

describe('.dev.vars.example', () => {
  it('names every secret and switch', () => {
    for (const name of [
      'WORKOS_API_KEY',
      'WORKOS_CLIENT_ID',
      'WORKOS_COOKIE_PASSWORD',
      'WORKOS_ISSUER',
      'KEK_V1',
      'HERMES_BRIDGE_SECRET',
      'HERMES_CLOUD_CLIENT_ID',
      'HERMES_CLOUD_CLIENT_SECRET',
      'SENTRY_DSN',
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'MODEL_GATEWAY_MODE',
      'ENGINE_PAUSED',
      'AUTH_MODE',
      'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP',
      'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_AGENT',
    ]) {
      expect(example, `${name} is not documented`).toContain(name);
    }
  });

  it('holds no value for any real secret', () => {
    const secrets = [
      'WORKOS_API_KEY',
      'WORKOS_CLIENT_ID',
      'WORKOS_COOKIE_PASSWORD',
      'WORKOS_ISSUER',
      'KEK_V1',
      'HERMES_BRIDGE_SECRET',
      'HERMES_CLOUD_CLIENT_ID',
      'HERMES_CLOUD_CLIENT_SECRET',
      'SENTRY_DSN',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ];
    for (const name of secrets) {
      const line = example.split('\n').find((l) => l.startsWith(`${name}=`));
      expect(line, `${name} has no line`).toBeDefined();
      expect(line, `${name} carries a value`).toBe(`${name}=""`);
    }
  });
});
