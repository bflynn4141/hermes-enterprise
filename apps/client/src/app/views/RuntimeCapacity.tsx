import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAdapter, useAppState, useIsAdmin } from '../store-context.js';
import { Ack, Button, Dialog, EmptyState, Skeleton } from '../ui/primitives.js';
import { RestError } from '../../model/rest.js';
import {
  hermesCapacityInputSchema,
  runtimeDiscoveryGrantInputSchema,
  runtimeGrantStatusLabel,
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
    : { label: 'Partnerships P1.7', skillKey: 'partner-program-screening', skillVersion: '1.7.0' };
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

function withReference(message: string, error: RestError): string {
  return error.traceId ? `${message} Reference: ${error.traceId}.` : message;
}

export function runtimeCapacityErrorMessage(error: unknown, action: 'load' | 'prepare' | 'register' | 'revoke'): string {
  if (!(error instanceof RestError)) return 'Hermes capacity could not be updated. Try again.';
  const known: Record<string, string> = {
    admin_required: 'Only a workspace Admin can manage Hermes capacity.',
    bad_discovery_grant: 'Enter the permanent Enterprise Agent UUID from the reviewed setup.',
    discovery_profile_assigned: 'That Agent UUID already belongs to a runtime. Use a new permanent identity.',
    discovery_grant_exists: 'That profile already has an active discovery credential. Revoke it before rotating.',
    discovery_profile_mismatch: 'That Agent UUID does not have the reviewed role profile.',
    discovery_profile_changed: 'The reviewed role profile changed. Revoke this credential and prepare another.',
    discovery_grant_unavailable: 'That discovery credential is no longer available. Prepare another.',
    discovery_grant_reserved: 'Withdraw the invitation using this profile before revoking its credential.',
    discovery_grant_consumed: 'This runtime is already assigned. Rotate its credential from the runtime.',
    discovery_grant_linked: 'This linked profile must be retired through its current lifecycle.',
    bad_capacity: 'Check every field. The connector must be a clean HTTPS URL and the control secret must be complete.',
    capacity_not_ready: 'The connector did not prove the required Cloud and Enterprise readiness. Check the instance and try again.',
    capacity_exists: 'That Cloud instance is already registered.',
    not_found: 'That discovery credential no longer exists.',
    csrf_failed: 'Refresh this page and try again.',
  };
  const fallback = action === 'load'
    ? 'Hermes capacity could not be loaded. Try again.'
    : action === 'prepare'
      ? 'The discovery credential could not be prepared. Try again.'
      : action === 'register'
        ? 'The Cloud instance could not be verified and added. Try again.'
        : 'The discovery credential could not be revoked. Try again.';
  return withReference(known[error.reason] ?? fallback, error);
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
      setError('Enter a valid permanent Agent UUID.');
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
      setNotice('Discovery credential prepared. Copy it into Cloud now; Hermes will not show it again.');
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
      setError('Prepare and select a discovery credential first.');
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
      setError(input.error.issues[0]?.message ?? 'Check every registration field.');
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
      setNotice(`${capacity.instance_name} passed live readiness checks and is available for assignment.`);
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
      setNotice('Discovery credential revoked.');
    } catch (caught) {
      if (caught instanceof RestError && caught.reauthRequired) stepUp();
      else setError(runtimeCapacityErrorMessage(caught, 'revoke'));
    } finally {
      setBusy(null);
    }
  };

  if (!admin) {
    return <EmptyState icon="context" title="Admin decision required" detail="Only a workspace Admin can prepare credentials or register Hermes Cloud capacity." />;
  }
  if (!grants) return <Skeleton rows={7} label="Loading Hermes capacity" />;

  return (
    <div className="runtime-capacity">
      <header className="runtime-capacity-heading">
        <div>
          <h2>Hermes capacity</h2>
          <p>Prepare one discovery credential, configure the permanent Enterprise Agent UUID on the native runtime, then verify its connector before making it available.</p>
        </div>
      </header>

      {error && <p className="runtime-capacity-error" role="alert">{error}</p>}
      {notice && <div className="runtime-capacity-notice" role="status">{notice}</div>}

      <section className="runtime-capacity-step" aria-labelledby="runtime-prepare-heading">
        <header>
          <span className="runtime-step-number" aria-hidden="true">1</span>
          <div>
            <h3 id="runtime-prepare-heading">Prepare discovery</h3>
            <p>Use a new permanent identity. Existing Iris identities are rejected to protect their current runtime binding.</p>
          </div>
        </header>
        <form className="runtime-capacity-form" autoComplete="off" onSubmit={(event) => void prepare(event)}>
          <label className="runtime-capacity-field runtime-capacity-wide">
            <span>Profile role</span>
            <select
              value={roleTemplateKey}
              onChange={(event) => setRoleTemplateKey(event.target.value as RuntimeCapacityRole)}
              disabled={busy !== null}
            >
              <option value="partnerships-agent">Partnerships P1.7</option>
              <option value="finance-agent">Finance</option>
            </select>
            <small>The credential is bound to this exact reviewed role profile.</small>
          </label>
          <label className="runtime-capacity-field runtime-capacity-wide">
            <span>Permanent Agent UUID</span>
            <input
              value={preflightAgentId}
              onChange={(event) => setPreflightAgentId(event.target.value.trim())}
              placeholder="00000000-0000-4000-8000-000000000000"
              inputMode="text"
              spellCheck={false}
              autoCapitalize="none"
              disabled={busy !== null}
            />
            <small>This is the Enterprise identity configured on the native runtime. It stays fixed for the agent.</small>
          </label>
          <footer>
            <span>Credentials expire after 24 hours until they are linked to verified capacity.</span>
            <Button primary type="submit" disabled={busy !== null || preflightAgentId.length === 0}>
              {busy === 'prepare' ? 'Preparing…' : 'Prepare credential'}
            </Button>
          </footer>
        </form>

        {createdCredential && (
          <div className="runtime-secret" role="group" aria-label="New discovery credential">
            <div>
              <strong>Discovery credential</strong>
              <span>Shown once. Copy it into Cloud, then hide it from this screen.</span>
            </div>
            <code>{createdCredential.bearer}</code>
            <div className="runtime-secret-actions">
              <Button small onClick={() => void copyCredential()}>{copyFailed ? 'Copy failed · try again' : 'Copy credential'}</Button>
              <Button small quiet onClick={() => setCreatedCredential(null)}>Hide credential</Button>
              <Ack show={copied}>Copied</Ack>
            </div>
          </div>
        )}
      </section>

      <section className="runtime-capacity-step" aria-labelledby="runtime-register-heading">
        <header>
          <span className="runtime-step-number" aria-hidden="true">2</span>
          <div>
            <h3 id="runtime-register-heading">Verify and add capacity</h3>
            <p>Hermes contacts the connector and checks the live runtime, exact plugin build, permanent identity, tools, and provider before saving it.</p>
          </div>
        </header>
        <form className="runtime-capacity-form" autoComplete="off" onSubmit={(event) => void register(event)}>
          <div className="runtime-capacity-grid">
            <label className="runtime-capacity-field">
              <span>Discovery grant</span>
              <select value={selectedGrantId} onChange={(event) => setSelectedGrantId(event.target.value)} disabled={busy !== null || preparedGrants.length === 0}>
                {preparedGrants.length === 0 && <option value="">Prepare a credential first</option>}
                {preparedGrants.map((grant) => <option key={grant.id} value={grant.id}>{grant.id}</option>)}
              </select>
            </label>
            <label className="runtime-capacity-field">
              <span>Permanent Agent UUID</span>
              <input value={selectedGrant?.preflight_agent_id ?? ''} readOnly aria-readonly="true" />
            </label>
            <label className="runtime-capacity-field">
              <span>Cloud agent ID</span>
              <input value={cloudAgentId} onChange={(event) => setCloudAgentId(event.target.value)} maxLength={200} autoCapitalize="none" spellCheck={false} disabled={busy !== null} />
            </label>
            <label className="runtime-capacity-field">
              <span>Instance name</span>
              <input value={instanceName} onChange={(event) => setInstanceName(event.target.value)} maxLength={120} disabled={busy !== null} />
            </label>
            <label className="runtime-capacity-field runtime-capacity-wide">
              <span>Connector HTTPS URL</span>
              <input type="url" value={connectorUrl} onChange={(event) => setConnectorUrl(event.target.value.trim())} placeholder="https://connector.example.com" autoCapitalize="none" spellCheck={false} disabled={busy !== null} />
              <small>No credentials, query parameters, or fragment.</small>
            </label>
            <label className="runtime-capacity-field runtime-capacity-wide">
              <span>Connector control secret</span>
              <input type="password" value={controlSecret} onChange={(event) => setControlSecret(event.target.value)} minLength={24} maxLength={500} autoComplete="new-password" spellCheck={false} disabled={busy !== null} />
              <small>Use the separate control secret from Cloud. It is cleared from this form as soon as verification succeeds.</small>
            </label>
          </div>
          <footer>
            <span>The instance is saved only after the live readiness proof succeeds.</span>
            <Button primary type="submit" disabled={busy !== null || !selectedGrant}>
              {busy === 'register' ? 'Verifying…' : 'Verify and add'}
            </Button>
          </footer>
        </form>
        {registered && (
          <div className="runtime-capacity-result">
            <strong>{registered.instance_name}</strong>
            <span>Available · plugin {registered.plugin_version}</span>
          </div>
        )}
      </section>

      <section className="runtime-grants" aria-labelledby="runtime-grants-heading">
        <div className="runtime-grants-title">
          <div>
            <h3 id="runtime-grants-heading">Discovery credentials</h3>
            <p>Only prepared credentials and linked, available capacity can be revoked here.</p>
          </div>
          <Button small onClick={() => void load()} disabled={busy !== null}>Refresh</Button>
        </div>
        {grants.length === 0 ? (
          <p className="runtime-grants-empty">No discovery credentials yet.</p>
        ) : grants.map((grant) => (
          <article className="runtime-grant-row" key={grant.id}>
            <div className="runtime-grant-main">
              <div className="runtime-grant-state">
                <strong>{grant.role}</strong>
                <span className={`pill ${statusPillClass(grant)}`}>
                  {runtimeGrantStatusLabel(grant)}
                </span>
              </div>
              <code>{grant.preflight_agent_id}</code>
              <span className="meta">Created {displayDate(grant.created_at)} · {grant.capacity_state ? `Cloud state: ${grant.capacity_state}` : `Expires ${displayDate(grant.expires_at)}`}</span>
            </div>
            {canRevoke(grant) && (
              <Button small disabled={busy !== null} onClick={() => setRevokeTarget(grant)}>
                {busy === `revoke:${grant.id}` ? 'Revoking…' : 'Revoke'}
              </Button>
            )}
          </article>
        ))}
      </section>

      <Dialog
        open={revokeTarget !== null}
        title="Revoke discovery credential?"
        onClose={() => busy === null && setRevokeTarget(null)}
        actions={(
          <>
            <Button onClick={() => setRevokeTarget(null)} disabled={busy !== null}>Cancel</Button>
            <Button primary onClick={() => void revoke()} disabled={busy !== null}>{busy?.startsWith('revoke:') ? 'Revoking…' : 'Revoke'}</Button>
          </>
        )}
      >
        <p>This credential stops working immediately. Linked, available capacity will be quarantined and cannot be assigned.</p>
        {revokeTarget && <code className="runtime-dialog-id">{revokeTarget.preflight_agent_id}</code>}
      </Dialog>
    </div>
  );
}
