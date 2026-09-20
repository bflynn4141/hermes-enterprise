import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  withWorkspaceTransaction: vi.fn(),
  hasCurrentReservedCapacityForInvitation: vi.fn(),
  reserveCapacityForInvitation: vi.fn(),
  releaseInvitationCapacity: vi.fn(),
  withCapacityGrantQuarantine: vi.fn(),
}));

vi.mock('../../src/jobs.js', () => ({
  enqueueJob: mocks.enqueueJob,
  withWorkspaceTransaction: mocks.withWorkspaceTransaction,
}));

vi.mock('../../src/hermes-cloud/capacity.js', () => ({
  hasCurrentReservedCapacityForInvitation: mocks.hasCurrentReservedCapacityForInvitation,
  reserveCapacityForInvitation: mocks.reserveCapacityForInvitation,
  releaseInvitationCapacity: mocks.releaseInvitationCapacity,
  withCapacityGrantQuarantine: mocks.withCapacityGrantQuarantine,
}));

vi.mock('../../src/routes/tenant.js', () => ({
  RouteError: class extends Error {
    constructor(message: string, readonly reason: string, readonly status = 400) { super(message); }
  },
}));

import {
  createMemberProvisioningOperation,
  projectMemberProvisioning,
  rebindMemberProvisioningOperation,
  requestMemberProvisioningCancellation,
  runMemberProvisioningJob,
  wakeMemberProvisioningForCloudConnection,
} from '../../src/member-provisioning/service.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const invitationId = '33333333-3333-4333-8333-333333333333';
const successorInvitationId = '44444444-4444-4444-8444-444444444444';
const requestedBy = '55555555-5555-4555-8555-555555555555';
const env = { HERMES_MEMBER_PROVISIONING_ENABLED: '1' } as Env;

type Preparation = 'awaiting_connection' | 'queued' | 'creating' | 'configuring' | 'verifying' | 'ready' | 'reconciliation_required' | 'failed';
type Cancellation = 'none' | 'requested' | 'complete';
type Issue = 'cloud_not_connected' | 'cloud_reconnect_required' | 'billing_unverified' | 'insufficient_credits'
  | 'cloud_contract_unverified' | 'bootstrap_unsupported' | 'readiness_failed' | 'creation_outcome_unknown'
  | 'delivery_outcome_unknown' | 'delivery_rejected' | 'authorization_revoked' | 'temporary_failure' | null;

interface Row {
  id: string;
  workspace_id: string;
  invitation_id: string;
  requested_by: string;
  role_template_key: 'partnerships-agent' | 'finance-agent';
  role_template_version: '1.0.0';
  revision: number;
  preparation: Preparation;
  cancellation: Cancellation;
  issue: Issue;
  invitation_status: string;
  delivery_status: string;
  delivery_error: string | null;
  cloud_status: string | null;
  requester_authorized: boolean;
  ready_reservation_current?: boolean;
}

function baseRow(overrides: Partial<Row> = {}): Row {
  return {
    id: operationId,
    workspace_id: workspaceId,
    invitation_id: invitationId,
    requested_by: requestedBy,
    role_template_key: 'partnerships-agent',
    role_template_version: '1.0.0',
    revision: 0,
    preparation: 'queued',
    cancellation: 'none',
    issue: null,
    invitation_status: 'pending',
    delivery_status: 'not_required',
    delivery_error: null,
    cloud_status: 'connected',
    requester_authorized: true,
    ...overrides,
  };
}

function transaction(initial: Row | null = null) {
  let row = initial ? { ...initial } : null;
  let connectionStatus: string | null = initial?.cloud_status ?? null;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT status FROM cloud_connections')) {
      return { rows: connectionStatus ? [{ status: connectionStatus }] : [], rowCount: connectionStatus ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO member_provisioning_operations')) {
      if (!row) {
        row = baseRow({
          workspace_id: String(params[0]), invitation_id: String(params[1]), requested_by: String(params[2]),
          role_template_key: params[3] as Row['role_template_key'], preparation: params[4] as Preparation,
          issue: params[5] as Issue, cloud_status: connectionStatus,
        });
      }
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes('SET cancellation=\'requested\'')) {
      if (!row || row.workspace_id !== params[0] || row.invitation_id !== params[1]
        || row.cancellation !== 'none' || row.invitation_status === 'accepted') return { rows: [], rowCount: 0 };
      row.cancellation = 'requested';
      row.revision += 1;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes('SET invitation_id=$3')) {
      if (!row || row.workspace_id !== params[0] || row.invitation_id !== params[1] || row.cancellation !== 'none') {
        return { rows: [], rowCount: 0 };
      }
      row.invitation_id = String(params[2]);
      row.requested_by = String(params[3]);
      if (row.preparation === 'ready' && params[4] === false) {
        row.preparation = 'queued';
        row.issue = 'readiness_failed';
      }
      row.revision += 1;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("SET preparation='queued', issue=NULL") && sql.includes("preparation='awaiting_connection'")) {
      if (!row || row.preparation !== 'awaiting_connection' || row.cancellation !== 'none') return { rows: [], rowCount: 0 };
      row.preparation = 'queued';
      row.issue = null;
      row.revision += 1;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes('SELECT invitation_id FROM member_provisioning_operations')) {
      return { rows: row ? [{ invitation_id: row.invitation_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM invitations') && sql.includes('FOR UPDATE')) {
      return { rows: row ? [{
        status: row.invitation_status,
        delivery_status: row.delivery_status,
        delivery_error: row.delivery_error,
      }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM member_provisioning_operations op')) {
      return { rows: row ? [{ ...row, cloud_status: connectionStatus }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM members') && sql.includes('FOR UPDATE')) {
      return { rows: row ? [{ authorized: row.requester_authorized }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("SET cancellation='complete'")) {
      if (row && row.revision === params[2]) {
        row.cancellation = 'complete';
        row.revision += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SET preparation='ready'")) {
      if (row && row.revision === params[2]) {
        row.preparation = 'ready';
        row.issue = null;
        row.revision += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SET preparation='awaiting_connection'")) {
      if (row && row.revision === params[2]) {
        row.preparation = 'awaiting_connection';
        row.issue = params[3] as Issue;
        row.revision += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SET preparation='failed'")) {
      if (row && row.revision === params[2]) {
        row.preparation = 'failed';
        row.issue = sql.includes("issue='authorization_revoked'") ? 'authorization_revoked' : 'cloud_contract_unverified';
        row.revision += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    tx: { query },
    row: () => row,
    setConnectionStatus: (status: string | null) => { connectionStatus = status; },
  };
}

function job(revision = 0) {
  return {
    id: '66666666-6666-4666-8666-666666666666', workspace_id: workspaceId,
    kind: 'member_provision', key: `member-provision:${operationId}:${revision}`,
    payload: { operation_id: operationId, revision }, attempts: 1,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('member provisioning must not use network'); }));
  const keys = new Set<string>();
  mocks.enqueueJob.mockImplementation(async (_tx, _workspace, kind: string, key: string) => {
    expect(kind).toBe('member_provision');
    if (keys.has(key)) return null;
    keys.add(key);
    return `job-${keys.size}`;
  });
  mocks.withCapacityGrantQuarantine.mockImplementation(async (_env, operation) => operation());
  mocks.hasCurrentReservedCapacityForInvitation.mockResolvedValue(false);
  mocks.reserveCapacityForInvitation.mockResolvedValue(null);
  mocks.releaseInvitationCapacity.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe('member provisioning persistence and projection', () => {
  it('durably queues a Cloud wake while the release flag is off so the job can pause', async () => {
    const db = transaction(baseRow({ preparation: 'awaiting_connection' }));

    expect(await wakeMemberProvisioningForCloudConnection({} as Env, db.tx as never, workspaceId)).toEqual(['job-1']);
    expect(db.row()).toMatchObject({ preparation: 'queued', issue: null, revision: 1 });
    expect(mocks.enqueueJob).toHaveBeenCalledWith(db.tx, workspaceId, 'member_provision',
      `member-provision:${operationId}:1`, { operation_id: operationId, revision: 1 });
  });

  it('creates one idempotent operation and one revision-bound job', async () => {
    const db = transaction();
    db.setConnectionStatus('connected');
    const input = { workspaceId, invitationId, requestedBy, roleTemplateKey: 'partnerships-agent' as const };

    const first = await createMemberProvisioningOperation(db.tx as never, input);
    const duplicate = await createMemberProvisioningOperation(db.tx as never, input);

    expect(first.operation).toMatchObject({ id: operationId, revision: 0, preparation: 'queued', delivery: 'not_queued' });
    expect(first.jobId).toBe('job-1');
    expect(duplicate.operation).toEqual(first.operation);
    expect(duplicate.jobId).toBeNull();
    expect(mocks.enqueueJob).toHaveBeenNthCalledWith(1, db.tx, workspaceId, 'member_provision',
      `member-provision:${operationId}:0`, { operation_id: operationId, revision: 0 });
  });

  it('derives safe delivery and membership without projecting provider detail', () => {
    const sent = projectMemberProvisioning(baseRow({
      preparation: 'ready', invitation_status: 'accepted', delivery_status: 'delivered',
      delivery_error: 'provider-secret-that-must-not-project',
    }));
    const uncertain = projectMemberProvisioning(baseRow({
      preparation: 'ready', delivery_status: 'failed', delivery_error: 'workos_invitation_delivery_outcome_unknown',
    }));

    expect(sent).toEqual({
      id: operationId, workspace_id: workspaceId, revision: 0, preparation: 'ready', delivery: 'sent',
      membership: 'joined', cancellation: 'none', issue: null,
    });
    expect(uncertain.delivery).toBe('reconciliation_required');
    expect(JSON.stringify([sent, uncertain])).not.toContain('provider-secret');
    expect(JSON.stringify(uncertain)).not.toContain('workos_invitation');
  });

  it('does not project ready after the read model proves the exact reservation is gone', () => {
    expect(projectMemberProvisioning(baseRow({
      preparation: 'ready', ready_reservation_current: false,
    }))).toMatchObject({ preparation: 'queued', issue: 'readiness_failed' });
    expect(projectMemberProvisioning(baseRow({
      preparation: 'ready', ready_reservation_current: true,
    }))).toMatchObject({ preparation: 'ready', issue: null });
  });

  it.each([
    { connection: null, preparation: 'awaiting_connection', issue: 'cloud_not_connected' },
    { connection: 'reconnect_required', preparation: 'awaiting_connection', issue: 'cloud_reconnect_required' },
  ])('settles a no-capacity operation safely when Cloud is $connection', async expected => {
    const db = transaction(baseRow({ cloud_status: expected.connection }));
    db.setConnectionStatus(expected.connection);
    mocks.withWorkspaceTransaction.mockImplementation(async (_env, _workspace, operation) => operation(db.tx));

    await runMemberProvisioningJob(env, job());

    expect(db.row()).toMatchObject({ preparation: expected.preparation, issue: expected.issue, revision: 1 });
    expect(mocks.reserveCapacityForInvitation).toHaveBeenCalledOnce();
  });

  it('fails explicitly when Cloud is connected but no verified capacity or lifecycle adapter exists', async () => {
    const db = transaction(baseRow({ cloud_status: 'connected' }));
    mocks.withWorkspaceTransaction.mockImplementation(async (_env, _workspace, operation) => operation(db.tx));

    await runMemberProvisioningJob(env, job());

    expect(db.row()).toMatchObject({ preparation: 'failed', issue: 'cloud_contract_unverified', revision: 1 });
  });
});

describe('member provisioning reservation and recovery boundaries', () => {
  it('promotes an existing verified Partnerships reservation to ready', async () => {
    const db = transaction(baseRow());
    mocks.withWorkspaceTransaction.mockImplementation(async (_env, _workspace, operation) => operation(db.tx));
    mocks.reserveCapacityForInvitation.mockResolvedValue({ id: 'capacity-1', remaining: 0 });

    await runMemberProvisioningJob(env, job());

    expect(mocks.reserveCapacityForInvitation).toHaveBeenCalledWith(env, db.tx, workspaceId, invitationId, {
      roleTemplateKey: 'partnerships-agent', roleTemplateVersion: '1.0.0',
    });
    expect(db.row()).toMatchObject({ preparation: 'ready', issue: null, revision: 1 });
  });

  it('requests only an exact Finance slot for an existing Finance operation', async () => {
    const db = transaction(baseRow({ role_template_key: 'finance-agent' }));
    mocks.withWorkspaceTransaction.mockImplementation(async (_env, _workspace, operation) => operation(db.tx));

    await runMemberProvisioningJob(env, job());

    expect(mocks.reserveCapacityForInvitation).toHaveBeenCalledWith(env, db.tx, workspaceId, invitationId, {
      roleTemplateKey: 'finance-agent', roleTemplateVersion: '1.0.0',
    });
    expect(db.row()).toMatchObject({ preparation: 'failed', issue: 'cloud_contract_unverified' });
  });

  it('ignores a stale revision before reservation or mutation', async () => {
    const db = transaction(baseRow({ revision: 2 }));
    mocks.withWorkspaceTransaction.mockImplementation(async (_env, _workspace, operation) => operation(db.tx));

    await runMemberProvisioningJob(env, job(1));

    expect(mocks.reserveCapacityForInvitation).not.toHaveBeenCalled();
    expect(mocks.releaseInvitationCapacity).not.toHaveBeenCalled();
    expect(db.row()).toMatchObject({ revision: 2, preparation: 'queued' });
    expect(db.tx.query).toHaveBeenCalledTimes(3);
  });

  it('completes cancellation only after releasing its reservation', async () => {
    const db = transaction(baseRow({ cancellation: 'requested', revision: 4 }));
    mocks.withWorkspaceTransaction.mockImplementation(async (_env, _workspace, operation) => operation(db.tx));

    await runMemberProvisioningJob(env, job(4));

    expect(mocks.releaseInvitationCapacity).toHaveBeenCalledWith(db.tx, workspaceId, invitationId);
    expect(mocks.releaseInvitationCapacity.mock.invocationCallOrder[0])
      .toBeLessThan(db.tx.query.mock.invocationCallOrder.at(-1)!);
    expect(db.row()).toMatchObject({ cancellation: 'complete', revision: 5 });
    expect(mocks.reserveCapacityForInvitation).not.toHaveBeenCalled();
  });

  it('rebinds the same operation and preserves preparation without provisioning again', async () => {
    const db = transaction(baseRow({ preparation: 'ready', revision: 3 }));

    const result = await rebindMemberProvisioningOperation(
      db.tx as never, workspaceId, invitationId, successorInvitationId, requestedBy, true,
    );

    expect(result?.operation).toMatchObject({ id: operationId, revision: 4, preparation: 'ready', delivery: 'not_queued' });
    expect(db.row()).toMatchObject({ id: operationId, invitation_id: successorInvitationId, revision: 4, preparation: 'ready' });
    expect(mocks.reserveCapacityForInvitation).not.toHaveBeenCalled();
    expect(result?.jobId).toBe('job-1');
  });

  it('demotes ready on rebind when the exact reservation did not transfer', async () => {
    const db = transaction(baseRow({ preparation: 'ready', revision: 3 }));

    const result = await rebindMemberProvisioningOperation(
      db.tx as never, workspaceId, invitationId, successorInvitationId, requestedBy, false,
    );

    expect(result?.operation).toMatchObject({ revision: 4, preparation: 'queued', issue: 'readiness_failed' });
    expect(db.row()).toMatchObject({ invitation_id: successorInvitationId, preparation: 'queued', issue: 'readiness_failed' });
  });

  it('revision-binds cancellation requests and refuses accepted invitations', async () => {
    const cancellable = transaction(baseRow());
    expect(await requestMemberProvisioningCancellation(cancellable.tx as never, workspaceId, invitationId)).toBe('job-1');
    expect(cancellable.row()).toMatchObject({ cancellation: 'requested', revision: 1 });

    const accepted = transaction(baseRow({ invitation_status: 'accepted', preparation: 'ready', delivery_status: 'delivered' }));
    expect(await requestMemberProvisioningCancellation(accepted.tx as never, workspaceId, invitationId)).toBeNull();
    expect(accepted.row()?.cancellation).toBe('none');
  });

  it('performs no Cloud lifecycle request and never queues WorkOS delivery', async () => {
    const db = transaction(baseRow({ cloud_status: 'connected' }));
    mocks.withWorkspaceTransaction.mockImplementation(async (_env, _workspace, operation) => operation(db.tx));

    await runMemberProvisioningJob(env, job());

    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect(db.tx.query.mock.calls.map(([sql]) => sql).join('\n')).not.toContain('workos_sync');
  });

  it('checks the release flag at execution time without blocking cancellation cleanup', async () => {
    const disabled = {} as Env;
    const queued = transaction(baseRow());
    mocks.withWorkspaceTransaction.mockImplementationOnce(async (_env, _workspace, operation) => operation(queued.tx));

    expect(await runMemberProvisioningJob(disabled, job())).toBe('paused');

    expect(mocks.reserveCapacityForInvitation).not.toHaveBeenCalled();
    expect(queued.row()).toMatchObject({ preparation: 'queued', revision: 0 });

    const cancelling = transaction(baseRow({ cancellation: 'requested', revision: 4 }));
    mocks.withWorkspaceTransaction.mockImplementationOnce(async (_env, _workspace, operation) => operation(cancelling.tx));

    await runMemberProvisioningJob(disabled, job(4));

    expect(mocks.releaseInvitationCapacity).toHaveBeenCalledWith(cancelling.tx, workspaceId, invitationId);
    expect(cancelling.row()).toMatchObject({ cancellation: 'complete', revision: 5 });
  });

  it('rechecks requesting Admin authority before reserving capacity', async () => {
    const db = transaction(baseRow({ requester_authorized: false }));
    mocks.withWorkspaceTransaction.mockImplementation(async (_env, _workspace, operation) => operation(db.tx));

    await runMemberProvisioningJob(env, job());

    expect(mocks.reserveCapacityForInvitation).not.toHaveBeenCalled();
    expect(mocks.releaseInvitationCapacity).toHaveBeenCalledWith(db.tx, workspaceId, invitationId);
    expect(db.row()).toMatchObject({ preparation: 'failed', issue: 'authorization_revoked', revision: 1 });
  });

  it.each(['withdrawn', 'expired', 'resent'])('rechecks terminal invitation state %s before reservation', async invitationStatus => {
    const db = transaction(baseRow({ invitation_status: invitationStatus, revision: 2 }));
    mocks.withWorkspaceTransaction.mockImplementation(async (_env, _workspace, operation) => operation(db.tx));

    await runMemberProvisioningJob(env, job(2));

    expect(mocks.reserveCapacityForInvitation).not.toHaveBeenCalled();
    expect(mocks.releaseInvitationCapacity).toHaveBeenCalledWith(db.tx, workspaceId, invitationId);
    expect(db.row()).toMatchObject({ cancellation: 'complete', revision: 3 });
  });
});
