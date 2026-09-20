// Read-only preflight. Node 26 strips the adapter's erasable TypeScript syntax.
// Optional credentials come from the process environment, never argv or logs.
import { discoverCloudOAuth, inspectCloudTools, CloudManagementError } from '../src/hermes-cloud/management.ts';

try {
  const metadata = await discoverCloudOAuth();
  const accessToken = process.env.HERMES_CLOUD_PREFLIGHT_ACCESS_TOKEN;
  const scope = process.env.HERMES_CLOUD_PREFLIGHT_SCOPE;
  if (Boolean(accessToken) !== Boolean(scope)) throw new CloudManagementError('cloud_scope_invalid');
  const contracts = accessToken && scope ? await inspectCloudTools({ accessToken, scope }) : null;
  // Public metadata and tool argument schemas only. Never print grants,
  // session IDs, account records, provider error bodies, or tool descriptions.
  process.stdout.write(JSON.stringify({ metadata,
    authenticatedToolDiscovery: contracts ? 'verified' : 'not_attempted',
    contracts,
    provisioning: 'not_attempted', billingAssociation: 'not_verified',
  }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ reason: error instanceof CloudManagementError ? error.reason : 'cloud_preflight_failed' }) + '\n');
  process.exitCode = 1;
}
