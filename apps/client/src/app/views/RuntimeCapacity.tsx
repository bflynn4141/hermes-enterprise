import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AdminPageHeader } from './AdminDetailLayout.js';
import { useAdapter, useAppState, useIsAdmin } from '../store-context.js';
import { Ack, Button, Dialog, EmptyState, Skeleton } from '../ui/primitives.js';
import { RestError } from '../../model/rest.js';
import {
  hermesCapacityInputSchema,
  runtimeDiscoveryGrantInputSchema,
  type HermesCapacity,
  type RuntimeCapacityRole,
  type RuntimeDiscoveryGrant,
  type RuntimeDiscoveryGrantCreated,
} from '../../model/runtime-capacity.js';

type BusyAction = 'prepare' | 'register' | `revoke:${string}` | null;

function roleProfile(role: RuntimeCapacityRole): {
  label: string;
  skillKey: 'partner-program-screening' | 'partner-invoice-review';
  skillVersion: '1.7.0' | '1.0.1';
} {
  return role === 'finance-agent'
    ? { label: 'Finance', skillKey: 'partner-invoice-review', skillVersion: '1.0.1' }
    : { label: 'Partnerships', skillKey: 'partner-program-screening', skillVersion: '1.7.0' };
}

function displayDate(value: string | null): string {
  if (!value) return 'No expiry while linked';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Server reason codes, in words an Admin can act on. Trace ids stay in the
 * error for support and logs; they are not rendered (docs/DESIGN.md).
 */
export function runtimeCapacityErrorMessage(error: unknown, action: 'load' | 'prepare' | 'register' | 'revoke'): string {
  if (!(error instanceof RestError)) return 'That did not work. Nothing changed. Try again.';
  const known: Record<string, string> = {
    admin_required: 'Only a workspace Admin can add agents.',
    bad_discovery_grant: 'Enter the agent ID from Hermes Cloud.',
    discovery_profile_assigned: 'That agent is already in use. Use a new agent.',
    discovery_grant_exists: 'That agent already has a setup code. Remove it before creating another.',
    discovery_profile_mismatch: 'That agent is set up for a different job role.',
    discovery_profile_changed: 'The job role changed after this code was made. Remove it and create another.',
    discovery_grant_unavailable: 'That setup code can no longer be used. Create another.',
    discovery_grant_reserved: 'Withdraw the invitation that is using this agent before removing it.',
    discovery_grant_consumed: 'This agent is already in use by a member.',
    discovery_grant_linked: 'This agent is in use, so it cannot be removed here.',
    bad_capacity: 'Check every field. The address must start with https:// and the secret must be complete.',
    capacity_not_ready: 'The agent did not pass Hermes’s checks. Check it in Hermes Cloud and try again.',
    capacity_exists: 'That agent is already added.',
    not_found: 'That setup code no longer exists.',
    csrf_failed: 'Refresh this page and try again.',
  };
  const fallback = action === 'load'
    ? 'Agent capacity could not be loaded. Try again.'
    : action === 'prepare'
      ? 'The setup code could not be created. Try again.'
      : action === 'register'
        ? 'The agent could not be checked and added. Try again.'
        : 'That could not be removed. Try again.';
  return known[error.reason] ?? fallback;
}

/** A setup code's state, in plain words. */
function grantStateLabel(grant: RuntimeDiscoveryGrant): string {
  switch (grant.status) {
    case 'prepared': return 'Waiting for the agent';
    case 'linked':
      switch (grant.capacity_state) {
        case 'available': return 'Ready for a new member';
        case 'reserved': return 'Set aside for an invitation';
        case 'assigning': return 'Being given to a member';
        case 'assigned': return 'In use';
        case 'quarantined': return 'Taken out of use';
        default: return 'Connected';
      }
    case 'consumed': return 'In use';
    case 'revoked': return 'Removed';
    case 'expired': return 'Expired';
  }
}

/** Which field a form check failed on, as a sentence; never the schema's own message. */
function registrationFieldMessage(field: unknown): string {
  switch (field) {
    case 'connector_url': return 'Enter the https:// address Hermes Cloud gave you, with nothing after the path.';
    case 'control_secret': return 'Enter the complete connection secret.';
    case 'cloud_agent_id': return 'Enter the Cloud agent ID.';
    case 'instance_name': return 'Give this agent a name.';
    default: return 'Check every field.';
  }
}

function canRevoke(grant: RuntimeDiscoveryGrant): boolean {
  return grant.status === 'prepared' || (grant.status === 'linked' && grant.capacity_state === 'available');
}

function statusPillClass(grant: RuntimeDiscoveryGrant): string {
  if (grant.status === 'prepared' || (grant.status === 'linked' && grant.capacity_state === 'available')) return 'pill-ok';
  if (grant.status === 'expired' || (grant.status === 'linked' && grant.capacity_state === 'quarantined')) return 'pill-warn';
  return '';
}

export function RuntimeCapacityTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const workspaceId = state.workspace.id;
  const [grants, setGrants] = useState<RuntimeDiscoveryGrant[] | null>(null);
  const [preflightAgentId, setPreflightAgentId] = useState('');
  const [roleTemplateKey, setRoleTemplateKey] = useState<RuntimeCapacityRole>('partnerships-agent');
  const [createdCredential, setCreatedCredential] = useState<RuntimeDiscoveryGrantCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [selectedGrantId, setSelectedGrantId] = useState('');
  const [cloudAgentId, setCloudAgentId] = useState('');
  const [instanceName, setInstanceName] = useState('');
  const [connectorUrl, setConnectorUrl] = useState('');
  const [controlSecret, setControlSecret] = useState('');
  const [busy, setBusy] = useState<BusyAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<RuntimeDiscoveryGrant | null>(null);
  const [registered, setRegistered] = useState<HermesCapacity | null>(null);

  const preparedGrants = useMemo(
    () => grants?.filter((grant) => grant.status === 'prepared') ?? [],
    [grants],
  );
  const selectedGrant = preparedGrants.find((grant) => grant.id === selectedGrantId) ?? null;

  const stepUp = useCallback((): void => {
    const url = adapter.auth.stepUpUrl(window.location.href, 'runtime_capacity');
    if (url) window.location.assign(url);
    else setError('This action needs a recent sign-in. Sign in again to continue.');
  }, [adapter]);

  const load = useCallback(async (): Promise<void> => {
    if (!workspaceId || !admin) return;
    try {
      const page = await adapter.rest.runtimeDiscoveryGrants(workspaceId);
      setGrants(page.grants);
      setRegistered(null);
      const available = page.grants.filter((grant) => grant.status === 'prepared');
      setSelectedGrantId((current) => available.some((grant) => grant.id === current) ? current : available[0]?.id ?? '');
      setError(null);
    } catch (caught) {
      if (caught instanceof RestError && caught.reauthRequired) {
        stepUp();
        return;
      }
      setError(runtimeCapacityErrorMessage(caught, 'load'));
      setGrants([]);
    }
  }, [adapter, admin, stepUp, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const prepare = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setNotice(null);
    setError(null);
    const input = runtimeDiscoveryGrantInputSchema.safeParse({
      preflight_agent_id: preflightAgentId,
      role_template_key: roleTemplateKey,
    });
    if (!input.success) {
      setError('Enter the agent ID from Hermes Cloud. It is a long code with dashes.');
      return;
    }
    setBusy('prepare');
    try {
      const created = await adapter.rest.createRuntimeDiscoveryGrant(workspaceId, input.data);
      const profile = roleProfile(created.role_template_key);
      setCreatedCredential(created);
      setCopied(false);
      setCopyFailed(false);
      setSelectedGrantId(created.id);
      setPreflightAgentId(created.preflight_agent_id);
      setGrants((current) => [{
        id: created.id,
        preflight_agent_id: created.preflight_agent_id,
        role_template_key: created.role_template_key,
        role_template_version: created.role_template_version,
        role: profile.label,
        skill_key: profile.skillKey,
        skill_version: profile.skillVersion,
        assignment_revision: null,
        grant_revision: 1,
        linked_capacity_id: null,
        capacity_state: null,
        status: 'prepared',
        expires_at: created.expires_at,
        created_at: created.created_at,
      }, ...(current ?? []).filter((grant) => grant.id !== created.id)]);
      setNotice('Setup code created. Copy it into Hermes Cloud now; Hermes will not show it again.');
    } catch (caught) {
      if (caught instanceof RestError && caught.reauthRequired) stepUp();
      else setError(runtimeCapacityErrorMessage(caught, 'prepare'));
    } finally {
      setBusy(null);
    }
  };

  const copyCredential = async (): Promise<void> => {
    if (!createdCredential) return;
    try {
      await navigator.clipboard.writeText(createdCredential.bearer);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  const register = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setNotice(null);
    setError(null);
    if (!selectedGrant) {
      setError('Create a setup code first.');
      return;
    }
    const input = hermesCapacityInputSchema.safeParse({
      cloud_agent_id: cloudAgentId,
      instance_name: instanceName,
      connector_url: connectorUrl,
      control_secret: controlSecret,
      preflight_agent_id: selectedGrant.preflight_agent_id,
      discovery_grant_id: selectedGrant.id,
    });
    if (!input.success) {
      setError(registrationFieldMessage(input.error.issues[0]?.path[0]));
      return;
    }
    setBusy('register');
    try {
      const capacity = await adapter.rest.registerHermesCapacity(workspaceId, input.data);
      setRegistered(capacity);
      setControlSecret('');
      setCreatedCredential((current) => current?.id === capacity.discovery_grant_id ? null : current);
      setGrants((current) => current?.map((grant) => grant.id === capacity.discovery_grant_id ? {
        ...grant,
        linked_capacity_id: capacity.id,
        capacity_state: 'available',
        status: 'linked',
        expires_at: null,
      } : grant) ?? []);
      setSelectedGrantId('');
      setNotice(`${capacity.instance_name} passed every check and is ready for a new member.`);
    } catch (caught) {
      if (caught instanceof RestError && caught.reauthRequired) stepUp();
      else setError(runtimeCapacityErrorMessage(caught, 'register'));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (): Promise<void> => {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setBusy(`revoke:${target.id}`);
    setNotice(null);
    setError(null);
    try {
      await adapter.rest.revokeRuntimeDiscoveryGrant(workspaceId, target.id);
      setRevokeTarget(null);
      if (createdCredential?.id === target.id) setCreatedCredential(null);
      setRegistered((current) => current?.discovery_grant_id === target.id ? null : current);
      setGrants((current) => current?.map((grant) => grant.id === target.id ? {
        ...grant,
        status: 'revoked',
        capacity_state: grant.linked_capacity_id ? 'quarantined' : grant.capacity_state,
      } : grant) ?? []);
      setNotice('Removed.');
    } catch (caught) {
      if (caught instanceof RestError && caught.reauthRequired) stepUp();
      else setError(runtimeCapacityErrorMessage(caught, 'revoke'));
    } finally {
      setBusy(null);
    }
  };

  if (!admin) {
    return <EmptyState icon="context" title="Admin decision required" detail="Only a workspace Admin can add agents." />;
  }
  if (!grants) return <Skeleton rows={7} label="Loading agent capacity" />;

  return (
    <div className="runtime-capacity">
      <AdminPageHeader title="Capacity" />

      {error && <p className="runtime-capacity-error" role="alert">{error}</p>}
      {notice && <div className="runtime-capacity-notice" role="status">{notice}</div>}

      <section className="runtime-capacity-step" aria-labelledby="runtime-prepare-heading">
        <header>
          <span className="runtime-step-number" aria-hidden="true">1</span>
          <div>
            <h3 id="runtime-prepare-heading">Create a setup code</h3>
            <p>Use a new agent. An agent that is already in use cannot be added again.</p>
          </div>
        </header>
        <form className="runtime-capacity-form" autoComplete="off" onSubmit={(event) => void prepare(event)}>
          <label className="runtime-capacity-field runtime-capacity-wide">
            <span>Job role</span>
            <select
              value={roleTemplateKey}
              onChange={(event) => setRoleTemplateKey(event.target.value as RuntimeCapacityRole)}
              disabled={busy !== null}
            >
              <option value="partnerships-agent">Partnerships</option>
              <option value="finance-agent">Finance</option>
            </select>
            <small>The setup code only works for this job role.</small>
          </label>
          <label className="runtime-capacity-field runtime-capacity-wide">
            <span>Agent ID</span>
            <input
              value={preflightAgentId}
              onChange={(event) => setPreflightAgentId(event.target.value.trim())}
              placeholder="Paste the agent ID"
              inputMode="text"
              spellCheck={false}
              autoCapitalize="none"
              disabled={busy !== null}
            />
            <small>The permanent ID this agent was given in Hermes Cloud.</small>
          </label>
          <footer>
            <span>A setup code expires after 24 hours unless its agent is connected.</span>
            <Button primary type="submit" disabled={busy !== null || preflightAgentId.length === 0}>
              {busy === 'prepare' ? 'Creating…' : 'Create setup code'}
            </Button>
          </footer>
        </form>

        {createdCredential && (
          <div className="runtime-secret" role="group" aria-label="New setup code">
            <div>
              <strong>Setup code</strong>
              <span>Shown once. Copy it into Hermes Cloud, then hide it.</span>
            </div>
            <code>{createdCredential.bearer}</code>
            <div className="runtime-secret-actions">
              <Button small onClick={() => void copyCredential()}>{copyFailed ? 'Copy failed · try again' : 'Copy setup code'}</Button>
              <Button small quiet onClick={() => setCreatedCredential(null)}>Hide setup code</Button>
              <Ack show={copied}>Copied</Ack>
            </div>
          </div>
        )}
      </section>

      <section className="runtime-capacity-step" aria-labelledby="runtime-register-heading">
        <header>
          <span className="runtime-step-number" aria-hidden="true">2</span>
          <div>
            <h3 id="runtime-register-heading">Connect and check the agent</h3>
            <p>Hermes contacts the agent and checks its version, its ID, its tools and its model provider before adding it.</p>
          </div>
        </header>
        <form className="runtime-capacity-form" autoComplete="off" onSubmit={(event) => void register(event)}>
          <div className="runtime-capacity-grid">
            <label className="runtime-capacity-field">
              <span>Setup code</span>
              <select value={selectedGrantId} onChange={(event) => setSelectedGrantId(event.target.value)} disabled={busy !== null || preparedGrants.length === 0}>
                {preparedGrants.length === 0 && <option value="">Create a setup code first</option>}
                {preparedGrants.map((grant) => <option key={grant.id} value={grant.id}>{grant.role} · created {displayDate(grant.created_at)}</option>)}
              </select>
            </label>
            <label className="runtime-capacity-field">
              <span>Cloud agent ID</span>
              <input value={cloudAgentId} onChange={(event) => setCloudAgentId(event.target.value)} maxLength={200} autoCapitalize="none" spellCheck={false} disabled={busy !== null} />
            </label>
            <label className="runtime-capacity-field">
              <span>Name for this agent</span>
              <input value={instanceName} onChange={(event) => setInstanceName(event.target.value)} maxLength={120} disabled={busy !== null} />
            </label>
            <label className="runtime-capacity-field runtime-capacity-wide">
              <span>Connection address</span>
              <input type="url" value={connectorUrl} onChange={(event) => setConnectorUrl(event.target.value.trim())} placeholder="https://connector.example.com" autoCapitalize="none" spellCheck={false} disabled={busy !== null} />
              <small>The https:// address Hermes Cloud gave you for this agent.</small>
            </label>
            <label className="runtime-capacity-field runtime-capacity-wide">
              <span>Connection secret</span>
              <input type="password" value={controlSecret} onChange={(event) => setControlSecret(event.target.value)} minLength={24} maxLength={500} autoComplete="new-password" spellCheck={false} disabled={busy !== null} />
              <small>The secret Hermes Cloud gave you with the address. Hermes clears it from this form once the check passes.</small>
            </label>
          </div>
          <footer>
            <span>Hermes adds the agent only if every check passes.</span>
            <Button primary type="submit" disabled={busy !== null || !selectedGrant}>
              {busy === 'register' ? 'Checking…' : 'Check and add'}
            </Button>
          </footer>
        </form>
        {registered && (
          <div className="runtime-capacity-result">
            <strong>{registered.instance_name}</strong>
            <span>Ready for a new member</span>
          </div>
        )}
      </section>

      <section className="runtime-grants" aria-labelledby="runtime-grants-heading">
        <div className="runtime-grants-title">
          <div>
            <h3 id="runtime-grants-heading">Setup codes and agents</h3>
            <p>You can remove an unused setup code, or an agent nobody has been given yet.</p>
          </div>
          <Button small onClick={() => void load()} disabled={busy !== null}>Refresh</Button>
        </div>
        {grants.length === 0 ? (
          <EmptyState compact icon="settings" title="No setup codes yet" />
        ) : grants.map((grant) => (
          <article className="runtime-grant-row" key={grant.id}>
            <div className="runtime-grant-main">
              <div className="runtime-grant-state">
                <strong>{grant.role}</strong>
                <span className={`pill ${statusPillClass(grant)}`}>
                  {grantStateLabel(grant)}
                </span>
              </div>
              <span className="meta">Created {displayDate(grant.created_at)}{grant.status === 'prepared' ? ` · Expires ${displayDate(grant.expires_at)}` : ''}</span>
            </div>
            {canRevoke(grant) && (
              <Button danger small disabled={busy !== null} onClick={() => setRevokeTarget(grant)}>
                {busy === `revoke:${grant.id}` ? 'Removing…' : 'Remove'}
              </Button>
            )}
          </article>
        ))}
      </section>

      <Dialog
        open={revokeTarget !== null}
        title={revokeTarget?.status === 'linked' ? 'Remove this agent?' : 'Remove this setup code?'}
        onClose={() => busy === null && setRevokeTarget(null)}
        actions={(
          <>
            <Button onClick={() => setRevokeTarget(null)} disabled={busy !== null}>Cancel</Button>
            <Button danger primary onClick={() => void revoke()} disabled={busy !== null}>{busy?.startsWith('revoke:') ? 'Removing…' : 'Remove'}</Button>
          </>
        )}
      >
        <p>The setup code stops working immediately. If an agent is already connected with it, the agent is taken out of use and cannot be given to anyone.</p>
        {revokeTarget && <p className="meta">{revokeTarget.role} · created {displayDate(revokeTarget.created_at)}</p>}
      </Dialog>
    </div>
  );
}
