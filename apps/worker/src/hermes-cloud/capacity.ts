import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/tenant.js';
import type { Job } from '../jobs.js';
import { enqueueJob, withWorkspaceTransaction } from '../jobs.js';
import { openSecret, sealSecret, type StoredEnvelope } from '../keys/envelope.js';
import {
  PARTNERSHIPS_CAPACITY_ROLE,
  requireCurrentGrantConfig,
  type CapacityRoleTemplate,
  type DiscoveryGrantRow,
} from '../runtime/discovery-grants.js';
import { HermesClient } from '../runtime/client.js';
import { matchesManagedDiscoveryGrantAttestation } from '../runtime/readiness.js';

export const POOL_CONTROL_NAMESPACE = 'hermes/pool-control/v1';
export const RUNTIME_CONTROL_NAMESPACE = 'hermes/runtime-control/v1';

interface EnvelopeRow {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  wrapped_dek: Uint8Array;
  wrap_iv: Uint8Array;
  kek_version: number;
}

export interface CapacityRow extends EnvelopeRow {
  id: string;
  cloud_agent_id: string;
  instance_name: string;
  preflight_agent_id: string;
  dashboard_url: string | null;
  connector_url: string;
  state: 'available' | 'reserved' | 'assigning' | 'assigned' | 'quarantined';
  reserved_invitation_id: string | null;
  assigned_agent_id: string | null;
  plugin_version: string;
  discovery_grant_id: string | null;
}

export interface CapacityAcceptanceProof {
  readonly workspaceId: string;
  readonly invitationId: string;
  readonly capacityId: string;
  readonly discoveryGrantId: string;
  readonly agentId: string;
  readonly connectorUrl: string;
  readonly roleTemplateKey: CapacityRoleTemplate['roleTemplateKey'];
  readonly roleTemplateVersion: CapacityRoleTemplate['roleTemplateVersion'];
  readonly skillKey: string;
  readonly skillVersion: string;
  readonly artifactDigest: string;
  readonly grantRevision: number;
  readonly configDigest: string;
  readonly pluginVersion: string;
  readonly checkedAt: Date;
}

function sameRole(actual: Pick<DiscoveryGrantRow, 'role_template_key' | 'role_template_version'>,
  expected: CapacityRoleTemplate): boolean {
  return actual.role_template_key === expected.roleTemplateKey &&
    actual.role_template_version === expected.roleTemplateVersion;
}

export async function capacityRoleForInvitation(
  tx: Pick<Tx, 'query'>,
  workspaceId: string,
  invitationId: string,
  options: { requireReadyOperation?: boolean } = {},
): Promise<CapacityRoleTemplate> {
  const { rows } = await tx.query<{
    role_template_key: CapacityRoleTemplate['roleTemplateKey'];
    role_template_version: string;
    preparation: string;
    cancellation: string;
  }>(
    `SELECT role_template_key,role_template_version,preparation,cancellation
       FROM member_provisioning_operations
      WHERE workspace_id=$1 AND invitation_id=$2`,
    [workspaceId, invitationId],
  );
  const operation = rows[0];
  if (!operation) return PARTNERSHIPS_CAPACITY_ROLE;
  if (operation.role_template_version !== '1.0.0' ||
      (options.requireReadyOperation &&
        (operation.preparation !== 'ready' || operation.cancellation !== 'none'))) {
    throw new RouteError(
      'This invitation does not have a current role-ready capacity contract.',
      'invitation_capacity_unavailable',
      409,
    );
  }
  return {
    roleTemplateKey: operation.role_template_key,
    roleTemplateVersion: '1.0.0',
  };
}

class CapacityGrantDriftError extends RouteError {
  handled = false;

  constructor(
    readonly workspaceId: string,
    readonly capacityId: string,
    readonly grantId: string,
  ) {
    super(
      'The linked Iris capacity no longer matches its reviewed discovery profile.',
      'iris_capacity_unavailable',
      409,
    );
  }
}

/** Persist quarantine only after the caller's failed transaction has released
 * its locks. This keeps a rejected invitation from rolling the quarantine back. */
export async function persistCapacityGrantDrift(env: Env, error: unknown): Promise<boolean> {
  if (!(error instanceof CapacityGrantDriftError)) return false;
  if (error.handled) return true;
  await withWorkspaceTransaction(env, error.workspaceId, async (tx) => {
    await tx.query(
      `UPDATE hermes_cloud_capacity
          SET state='quarantined', reserved_invitation_id=NULL,
              quarantined_at=now(), quarantine_reason='discovery_profile_changed'
        WHERE workspace_id=$1 AND id=$2 AND state IN ('available','reserved')`,
      [error.workspaceId, error.capacityId],
    );
    await tx.query(
      `UPDATE runtime_discovery_grants SET revoked_at=now()
        WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL AND consumed_at IS NULL`,
      [error.workspaceId, error.grantId],
    );
  });
  error.handled = true;
  return true;
}

export async function withCapacityGrantQuarantine<T>(
  env: Env,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await persistCapacityGrantDrift(env, error);
    throw error;
  }
}

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  throw new Error('expected Hermes capacity credential envelope bytes');
};

const stored = (row: EnvelopeRow): StoredEnvelope => ({
  ciphertext: bytes(row.ciphertext),
  iv: bytes(row.iv),
  wrappedDek: bytes(row.wrapped_dek),
  wrapIv: bytes(row.wrap_iv),
  kekVersion: row.kek_version,
});

export async function expireInvitationReservations(tx: Tx, workspaceId: string): Promise<number> {
  const expired = await tx.query<{ id: string }>(
    `UPDATE invitations
        SET status='expired', delivery_status=CASE WHEN delivery_status='delivered' THEN delivery_status ELSE 'failed' END
      WHERE workspace_id=$1 AND status='pending' AND expires_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM member_provisioning_operations op
           WHERE op.workspace_id=invitations.workspace_id
             AND op.invitation_id=invitations.id
             AND op.cancellation<>'complete'
             AND invitations.workos_invitation_id IS NULL
        )
      RETURNING id`,
    [workspaceId],
  );
  if (expired.rows.length === 0) return 0;
  await tx.query(
    `UPDATE member_provisioning_operations
        SET cancellation='complete', completed_at=now(), revision=revision+1
      WHERE workspace_id=$1 AND invitation_id=ANY($2::uuid[]) AND cancellation<>'complete'`,
    [workspaceId, expired.rows.map((row) => row.id)],
  );
  await tx.query(
    `UPDATE hermes_cloud_capacity
        SET state='available', reserved_invitation_id=NULL
      WHERE workspace_id=$1 AND state='reserved' AND reserved_invitation_id=ANY($2::uuid[])`,
    [workspaceId, expired.rows.map((row) => row.id)],
  );
  return expired.rows.length;
}

export async function reserveCapacityForInvitation(
  env: Env,
  tx: Tx,
  workspaceId: string,
  invitationId: string,
  expectedRole: CapacityRoleTemplate,
): Promise<{ id: string; remaining: number } | null> {
  await expireInvitationReservations(tx, workspaceId);
  const existing = await tx.query<{ id: string; discovery_grant_id: string | null }>(
    `SELECT id, discovery_grant_id FROM hermes_cloud_capacity
      WHERE workspace_id=$1 AND reserved_invitation_id=$2 AND state='reserved'
      FOR UPDATE`,
    [workspaceId, invitationId],
  );
  let id: string | null = null;
  const current = existing.rows[0];
  if (current) {
    if (current.discovery_grant_id &&
        await linkedGrantIsCurrent(env, tx, workspaceId, current.id, current.discovery_grant_id, expectedRole)) {
      id = current.id;
    }
  }
  if (!id) {
    const candidates = await tx.query<{ id: string; discovery_grant_id: string | null }>(
      `SELECT capacity.id,capacity.discovery_grant_id
         FROM hermes_cloud_capacity capacity
         JOIN runtime_discovery_grants grant_row
           ON grant_row.workspace_id=capacity.workspace_id
          AND grant_row.id=capacity.discovery_grant_id
          AND grant_row.linked_capacity_id=capacity.id
          AND grant_row.agent_id=capacity.preflight_agent_id
        WHERE capacity.workspace_id=$1 AND capacity.state='available'
          AND grant_row.role_template_key=$2 AND grant_row.role_template_version=$3
          AND capacity.native_cron_disabled
          AND capacity.agentcash_enabled=$4 AND capacity.agentcash_wallet_present=$4
        ORDER BY capacity.readiness_checked_at,capacity.created_at
        FOR UPDATE OF capacity SKIP LOCKED`,
      [workspaceId, expectedRole.roleTemplateKey, expectedRole.roleTemplateVersion,
        expectedRole.roleTemplateKey === 'partnerships-agent'],
    );
    for (const candidate of candidates.rows) {
      if (!candidate.discovery_grant_id ||
          !await linkedGrantIsCurrent(
            env, tx, workspaceId, candidate.id, candidate.discovery_grant_id, expectedRole,
          )) continue;
      const claimed = await tx.query<{ id: string }>(
        `UPDATE hermes_cloud_capacity SET state='reserved', reserved_invitation_id=$3
          WHERE workspace_id=$1 AND id=$2 AND state='available' RETURNING id`,
        [workspaceId, candidate.id, invitationId],
      );
      id = claimed.rows[0]?.id ?? null;
      if (id) break;
    }
  }
  if (!id) return null;
  const remainingRows = await tx.query<{ id: string; discovery_grant_id: string | null }>(
    `SELECT capacity.id,capacity.discovery_grant_id
       FROM hermes_cloud_capacity capacity
       JOIN runtime_discovery_grants grant_row
         ON grant_row.workspace_id=capacity.workspace_id
        AND grant_row.id=capacity.discovery_grant_id
        AND grant_row.linked_capacity_id=capacity.id
        AND grant_row.agent_id=capacity.preflight_agent_id
      WHERE capacity.workspace_id=$1 AND capacity.state='available'
        AND grant_row.role_template_key=$2 AND grant_row.role_template_version=$3
        AND capacity.native_cron_disabled
        AND capacity.agentcash_enabled=$4 AND capacity.agentcash_wallet_present=$4
      ORDER BY capacity.readiness_checked_at,capacity.created_at FOR UPDATE OF capacity`,
    [workspaceId, expectedRole.roleTemplateKey, expectedRole.roleTemplateVersion,
      expectedRole.roleTemplateKey === 'partnerships-agent'],
  );
  let remaining = 0;
  for (const row of remainingRows.rows) {
    if (row.discovery_grant_id &&
        await linkedGrantIsCurrent(
          env, tx, workspaceId, row.id, row.discovery_grant_id, expectedRole,
        )) remaining += 1;
  }
  return { id, remaining };
}

/**
 * Whether this workspace holds verified, unreserved capacity for `role`, or
 * whether `invitationId` already reserves one. A read-only projection used to
 * advertise and admit a job role before any row is written: the reservation
 * itself still revalidates the exact grant under row locks, so a stale answer
 * here can only refuse early, never widen what `reserveCapacityForInvitation`
 * would accept.
 */
export async function hasVerifiedCapacityForRole(
  tx: Pick<Tx, 'query'>,
  workspaceId: string,
  role: CapacityRoleTemplate,
  invitationId?: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM hermes_cloud_capacity capacity
         JOIN runtime_discovery_grants grant_row
           ON grant_row.workspace_id=capacity.workspace_id
          AND grant_row.id=capacity.discovery_grant_id
          AND grant_row.linked_capacity_id=capacity.id
          AND grant_row.agent_id=capacity.preflight_agent_id
        WHERE capacity.workspace_id=$1
          AND grant_row.role_template_key=$2 AND grant_row.role_template_version=$3
          AND grant_row.revoked_at IS NULL AND grant_row.consumed_at IS NULL AND grant_row.expires_at IS NULL
          AND capacity.native_cron_disabled
          AND capacity.agentcash_enabled=$4 AND capacity.agentcash_wallet_present=$4
          AND (capacity.state='available'
               OR (capacity.state='reserved' AND $5::uuid IS NOT NULL AND capacity.reserved_invitation_id=$5::uuid))
     ) AS found`,
    [workspaceId, role.roleTemplateKey, role.roleTemplateVersion,
      role.roleTemplateKey === 'partnerships-agent', invitationId ?? null],
  );
  return rows[0]?.found === true;
}

/** Revalidate the exact reservation behind a persisted `ready` operation. */
export async function hasCurrentReservedCapacityForInvitation(
  env: Env,
  tx: Tx,
  workspaceId: string,
  invitationId: string,
  expectedRole: CapacityRoleTemplate,
): Promise<boolean> {
  const { rows } = await tx.query<{ id: string; discovery_grant_id: string | null }>(
    `SELECT id, discovery_grant_id FROM hermes_cloud_capacity
      WHERE workspace_id=$1 AND reserved_invitation_id=$2 AND state='reserved'
      FOR UPDATE`,
    [workspaceId, invitationId],
  );
  const capacity = rows[0];
  return Boolean(capacity?.discovery_grant_id
    && await linkedGrantIsCurrent(
      env, tx, workspaceId, capacity.id, capacity.discovery_grant_id, expectedRole,
    ));
}

async function linkedGrantIsCurrent(
  env: Env,
  tx: Tx,
  workspaceId: string,
  capacityId: string,
  grantId: string,
  expectedRole: CapacityRoleTemplate,
  options: { allowAssignmentPromotion?: boolean } = {},
): Promise<DiscoveryGrantRow | null> {
  const { rows } = await tx.query<DiscoveryGrantRow>(
    `SELECT g.id, g.workspace_id, g.agent_id, g.credential_digest,
            g.role_template_key, g.role_template_version,
            g.skill_key, g.skill_version, g.runtime_name,
            g.artifact_digest, g.assignment_id, g.assignment_revision,
            g.config_digest, g.grant_revision, g.linked_capacity_id,
            g.expires_at, g.revoked_at, g.consumed_at, c.state AS capacity_state
       FROM runtime_discovery_grants g
       JOIN hermes_cloud_capacity c
         ON c.workspace_id=g.workspace_id
        AND c.id=g.linked_capacity_id
        AND c.discovery_grant_id=g.id
        AND c.preflight_agent_id=g.agent_id
      WHERE g.workspace_id=$1 AND g.id=$2 AND g.linked_capacity_id=$3
      FOR UPDATE OF g`,
    [workspaceId, grantId, capacityId],
  );
  const grant = rows[0];
  if (!grant || grant.revoked_at || grant.consumed_at || grant.expires_at !== null ||
      !['available', 'reserved'].includes(grant.capacity_state ?? '')) {
    throw new CapacityGrantDriftError(workspaceId, capacityId, grantId);
  }
  try {
    await requireCurrentGrantConfig(env, tx, grant, options);
    return sameRole(grant, expectedRole) ? grant : null;
  } catch (error) {
    if (error instanceof RouteError && error.reason === 'discovery_profile_changed') {
      throw new CapacityGrantDriftError(workspaceId, capacityId, grantId);
    }
    throw error;
  }
}

/** Probe the exact reserved connector without holding a database transaction
 * across the network. Acceptance later re-locks every identity in this proof
 * before it promotes the credential. */
export async function verifyReservedCapacityForInvitation(
  env: Env,
  workspaceId: string,
  invitationId: string,
  expectedRole?: CapacityRoleTemplate,
): Promise<CapacityAcceptanceProof> {
  const snapshot = await withCapacityGrantQuarantine(env, () => withWorkspaceTransaction(env, workspaceId, async (tx) => {
    const role = expectedRole ?? await capacityRoleForInvitation(
      tx, workspaceId, invitationId, { requireReadyOperation: true },
    );
    const { rows } = await tx.query<CapacityRow>(
      `SELECT id, cloud_agent_id, instance_name, preflight_agent_id, discovery_grant_id,
              dashboard_url, connector_url, state, reserved_invitation_id,
              assigned_agent_id, plugin_version,
              ciphertext, iv, wrapped_dek, wrap_iv, kek_version
         FROM hermes_cloud_capacity
        WHERE workspace_id=$1 AND reserved_invitation_id=$2 AND state='reserved'`,
      [workspaceId, invitationId],
    );
    const capacity = rows[0];
    const grant = capacity?.discovery_grant_id
      ? await linkedGrantIsCurrent(
        env, tx, workspaceId, capacity.id, capacity.discovery_grant_id, role,
      )
      : null;
    if (!capacity?.discovery_grant_id || !grant) {
      throw new RouteError(
        'This invitation no longer has verified Iris capacity.',
        'invitation_capacity_unavailable',
        409,
      );
    }
    const controlSecret = await openSecret(
      env,
      { workspaceId, keyId: capacity.id, namespace: POOL_CONTROL_NAMESPACE },
      stored(capacity),
    );
    return { capacity, controlSecret, grant, role };
  }));

  try {
    const runtime = new HermesClient(
      snapshot.capacity.connector_url,
      snapshot.controlSecret,
      undefined,
      'dashboard_connector',
    );
    const [capabilities, readiness] = await Promise.all([
      runtime.capabilities(),
      runtime.enterpriseReadiness(),
    ]);
    if (!capabilities.durableIdempotency ||
        !matchesManagedDiscoveryGrantAttestation(readiness, snapshot.grant, {
          workspaceId,
          agentId: snapshot.capacity.preflight_agent_id,
          enterpriseUrl: env.HERMES_ENTERPRISE_PUBLIC_URL,
          pluginRevision: env.HERMES_ENTERPRISE_PLUGIN_REVISION,
          pluginArtifactDigest: env.HERMES_ENTERPRISE_PLUGIN_SHA256,
        })) {
      throw new Error('capacity_not_ready');
    }
    return {
      workspaceId,
      invitationId,
      capacityId: snapshot.capacity.id,
      discoveryGrantId: snapshot.capacity.discovery_grant_id!,
      agentId: snapshot.capacity.preflight_agent_id,
      connectorUrl: snapshot.capacity.connector_url,
      roleTemplateKey: snapshot.role.roleTemplateKey,
      roleTemplateVersion: snapshot.role.roleTemplateVersion,
      skillKey: snapshot.grant.skill_key,
      skillVersion: snapshot.grant.skill_version,
      artifactDigest: snapshot.grant.artifact_digest,
      grantRevision: snapshot.grant.grant_revision,
      configDigest: snapshot.grant.config_digest,
      pluginVersion: readiness.version,
      checkedAt: new Date(),
    };
  } catch {
    throw new RouteError(
      'The reserved Iris profile did not pass a fresh readiness check. Try again after the runtime is healthy.',
      'invitation_capacity_unavailable',
      409,
    );
  }
}

export async function verifyPendingInvitationCapacityForEmail(
  env: Env,
  workspaceId: string,
  email: string,
): Promise<CapacityAcceptanceProof | null> {
  if (env.AGENT_RUNTIME !== 'hermes') return null;
  const pending = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM invitations
        WHERE workspace_id=$1 AND email=$2 AND status='pending' AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, email.toLowerCase()],
    );
    const invitationId = rows[0]?.id ?? null;
    if (!invitationId) return null;
    return {
      invitationId,
      role: await capacityRoleForInvitation(
        tx, workspaceId, invitationId, { requireReadyOperation: true },
      ),
    };
  });
  return pending
    ? verifyReservedCapacityForInvitation(env, workspaceId, pending.invitationId, pending.role)
    : null;
}

export async function releaseInvitationCapacity(tx: Tx, workspaceId: string, invitationId: string): Promise<void> {
  await tx.query(
    `UPDATE hermes_cloud_capacity
        SET state='available', reserved_invitation_id=NULL
      WHERE workspace_id=$1 AND reserved_invitation_id=$2 AND state='reserved'`,
    [workspaceId, invitationId],
  );
}

export async function transferInvitationCapacity(
  env: Env,
  tx: Tx,
  workspaceId: string,
  fromInvitationId: string,
  toInvitationId: string,
  expectedRole: CapacityRoleTemplate,
): Promise<boolean> {
  const { rows } = await tx.query<{ id: string; discovery_grant_id: string | null }>(
    `SELECT id, discovery_grant_id FROM hermes_cloud_capacity
      WHERE workspace_id=$1 AND reserved_invitation_id=$2 AND state='reserved'
      FOR UPDATE`,
    [workspaceId, fromInvitationId],
  );
  const capacity = rows[0];
  if (!capacity?.discovery_grant_id ||
      !await linkedGrantIsCurrent(
        env, tx, workspaceId, capacity.id, capacity.discovery_grant_id, expectedRole,
      )) return false;
  const moved = await tx.query(
    `UPDATE hermes_cloud_capacity SET reserved_invitation_id=$3
      WHERE workspace_id=$1 AND id=$4 AND reserved_invitation_id=$2 AND state='reserved'`,
    [workspaceId, fromInvitationId, toInvitationId, capacity.id],
  );
  return moved.rowCount === 1;
}

/** The Cloud profile is permanently bound to this identity before invitation. */
export async function reservedCapacityAgentId(
  tx: Tx,
  workspaceId: string,
  invitationId: string,
  expectedRole: CapacityRoleTemplate,
): Promise<string> {
  const result = await tx.query<{ preflight_agent_id: string }>(
    `SELECT capacity.preflight_agent_id
       FROM hermes_cloud_capacity capacity
       JOIN runtime_discovery_grants grant_row
         ON grant_row.workspace_id=capacity.workspace_id
        AND grant_row.id=capacity.discovery_grant_id
        AND grant_row.linked_capacity_id=capacity.id
        AND grant_row.agent_id=capacity.preflight_agent_id
      WHERE capacity.workspace_id=$1 AND capacity.reserved_invitation_id=$2
        AND capacity.state='reserved'
        AND grant_row.role_template_key=$3 AND grant_row.role_template_version=$4
      FOR UPDATE OF capacity`,
    [workspaceId, invitationId, expectedRole.roleTemplateKey, expectedRole.roleTemplateVersion],
  );
  const agentId = result.rows[0]?.preflight_agent_id;
  if (!agentId) {
    throw new RouteError(
      'This invitation no longer has an Iris reserved for it. Ask an organization admin to send a new invitation.',
      'invitation_capacity_unavailable',
      409,
    );
  }
  return agentId;
}

export async function consumeReservedCapacity(
  env: Env,
  tx: Tx,
  workspaceId: string,
  invitationId: string,
  agentId: string,
  expectedRole: CapacityRoleTemplate,
  proof: CapacityAcceptanceProof | null,
): Promise<CapacityRow> {
  const result = await tx.query<CapacityRow>(
    `SELECT id, cloud_agent_id, instance_name, preflight_agent_id, discovery_grant_id, dashboard_url, connector_url, state,
            reserved_invitation_id, assigned_agent_id, plugin_version,
            ciphertext, iv, wrapped_dek, wrap_iv, kek_version
       FROM hermes_cloud_capacity
      WHERE workspace_id=$1 AND reserved_invitation_id=$2 AND state='reserved'
      FOR UPDATE`,
    [workspaceId, invitationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RouteError(
      'This invitation no longer has an Iris reserved for it. Ask an organization admin to send a new invitation.',
      'invitation_capacity_unavailable',
      409,
    );
  }
  if (row.preflight_agent_id !== agentId) {
    throw new RouteError(
      'The reserved Iris identity does not match this invitation.',
      'invitation_capacity_mismatch',
      409,
    );
  }
  if (!proof || proof.workspaceId !== workspaceId || proof.invitationId !== invitationId ||
      proof.capacityId !== row.id || proof.discoveryGrantId !== row.discovery_grant_id ||
      proof.agentId !== row.preflight_agent_id || proof.connectorUrl !== row.connector_url ||
      proof.roleTemplateKey !== expectedRole.roleTemplateKey ||
      proof.roleTemplateVersion !== expectedRole.roleTemplateVersion ||
      !Number.isFinite(proof.checkedAt.getTime()) || proof.checkedAt > new Date() ||
      Date.now() - proof.checkedAt.getTime() > 30_000) {
    throw new RouteError(
      'The reserved Iris profile needs a fresh readiness check.',
      'invitation_capacity_unavailable',
      409,
    );
  }
  const currentGrant = row.discovery_grant_id
    ? await linkedGrantIsCurrent(
        env, tx, workspaceId, row.id, row.discovery_grant_id,
        expectedRole, { allowAssignmentPromotion: true },
      )
    : null;
  if (!currentGrant || proof.skillKey !== currentGrant.skill_key ||
      proof.skillVersion !== currentGrant.skill_version ||
      proof.artifactDigest !== currentGrant.artifact_digest ||
      proof.grantRevision !== currentGrant.grant_revision ||
      proof.configDigest !== currentGrant.config_digest) {
    throw new RouteError(
      'The reserved Iris profile no longer matches its reviewed discovery configuration.',
      'invitation_capacity_unavailable',
      409,
    );
  }
  const credential = await tx.query<{ credential_digest: Uint8Array }>(
    `SELECT credential_digest FROM runtime_discovery_grants
      WHERE workspace_id=$1 AND id=$2 AND linked_capacity_id=$3
        AND revoked_at IS NULL AND consumed_at IS NULL
      FOR UPDATE`,
    [workspaceId, row.discovery_grant_id, row.id],
  );
  const runtimeCredentialDigest = credential.rows[0]?.credential_digest ?? null;
  if (!runtimeCredentialDigest) throw new RouteError(
    'The reserved Iris profile no longer has a valid runtime credential.',
    'invitation_capacity_unavailable',
    409,
  );
  const secret = await openSecret(
    env,
    { workspaceId, keyId: row.id, namespace: POOL_CONTROL_NAMESPACE },
    stored(row),
  );
  const binding = await sealSecret(
    env,
    { workspaceId, keyId: agentId, namespace: RUNTIME_CONTROL_NAMESPACE },
    secret,
  );
  await tx.query(
    `INSERT INTO agent_runtime_bindings
       (workspace_id, agent_id, profile, base_url, transport, assignment, agentcash,
        ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
        runtime_auth_mode, runtime_credential_digest, ready_at)
     VALUES ($1,$2,$3,$4,'dashboard_connector',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (agent_id) DO UPDATE SET
       base_url=EXCLUDED.base_url, transport=EXCLUDED.transport,
       assignment=EXCLUDED.assignment, agentcash=EXCLUDED.agentcash,
       ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv,
       wrapped_dek=EXCLUDED.wrapped_dek, wrap_iv=EXCLUDED.wrap_iv,
       kek_version=EXCLUDED.kek_version,
       runtime_auth_mode=EXCLUDED.runtime_auth_mode,
       runtime_credential_digest=EXCLUDED.runtime_credential_digest,
       ready_at=EXCLUDED.ready_at`,
    [workspaceId, agentId, `agent-${agentId}`, row.connector_url,
     'invitee_pool',
     expectedRole.roleTemplateKey === 'partnerships-agent',
     Buffer.from(binding.ciphertext), Buffer.from(binding.iv), Buffer.from(binding.wrappedDek),
     Buffer.from(binding.wrapIv), binding.kekVersion,
     'token_digest', Buffer.from(runtimeCredentialDigest), proof.checkedAt],
  );
  await tx.query(
    `UPDATE hermes_cloud_capacity SET state='assigned', assigned_agent_id=$3, assigned_at=now(),
        plugin_version=$4, readiness_checked_at=$5, last_health_checked_at=$5
      WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,
    [workspaceId, row.id, agentId, proof.pluginVersion, proof.checkedAt],
  );
  const consumed = await tx.query(
    `UPDATE runtime_discovery_grants SET consumed_at=now()
      WHERE workspace_id=$1 AND id=$2 AND linked_capacity_id=$3
        AND revoked_at IS NULL AND consumed_at IS NULL`,
    [workspaceId, row.discovery_grant_id, row.id],
  );
  if (consumed.rowCount !== 1) throw new RouteError(
    'The runtime credential could not be promoted.',
    'invitation_capacity_unavailable',
    409,
  );
  await tx.query(
    `INSERT INTO agent_provisioning
       (workspace_id, agent_id, status, cloud_agent_id, instance_name, dashboard_url,
        requested_at, ready_at)
     VALUES ($1,$2,'ready',$3,$4,$5,now(),$6)
     ON CONFLICT (agent_id) DO UPDATE SET
       status='ready', cloud_agent_id=EXCLUDED.cloud_agent_id,
       instance_name=EXCLUDED.instance_name, dashboard_url=EXCLUDED.dashboard_url,
       ready_at=EXCLUDED.ready_at, error_code=NULL, error_detail=NULL`,
    [workspaceId, agentId, row.cloud_agent_id, row.instance_name, row.dashboard_url, proof.checkedAt],
  );
  return row;
}

export async function enqueueCapacityWarning(
  tx: Tx,
  workspaceId: string,
  remaining: number,
  threshold: number,
): Promise<void> {
  if (remaining > threshold) return;
  await enqueueJob(
    tx,
    workspaceId,
    'hermes_capacity_alert',
    `hermes-capacity-low:${workspaceId}:${remaining}:${new Date().toISOString().slice(0, 10)}`,
    { kind: 'low_capacity', remaining, threshold },
  );
}

export async function runInvitationExpirationJob(env: Env, job: Job): Promise<void> {
  await withWorkspaceTransaction(env, job.workspace_id, (tx) => expireInvitationReservations(tx, job.workspace_id));
}

export function runCapacityAlertJob(job: Job): void {
  console.warn(JSON.stringify({ at: 'hermes.capacity', workspace_id: job.workspace_id, ...((job.payload ?? {}) as object) }));
}
