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
      'KEK_V1',
      'SENTRY_DSN',
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
    const secrets = ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_COOKIE_PASSWORD', 'KEK_V1', 'SENTRY_DSN'];
    for (const name of secrets) {
      const line = example.split('\n').find((l) => l.startsWith(`${name}=`));
      expect(line, `${name} has no line`).toBeDefined();
      expect(line, `${name} carries a value`).toBe(`${name}=""`);
    }
  });
});
