// Admin → Connections → Overview: every outside connection on one list
// (docs/CONNECTORS.md, docs/DESIGN.md "Connections"). Each row is the
// service's logo, the account it acts as, what it can do in one sentence,
// and a status only when the status says something. The detail pages
// (Email, Slack) stay where they are; each row opens its own.
import { useEffect, useState } from 'react';
import { ADMIN, CONNECTORS, type ConnectorKey, type ConnectorList, type ConnectorStatus } from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { BrandIcon, type BrandName } from '../ui/brand-icons.js';
import { Button, EmptyState, Item, Pill, Skeleton, StatusDot } from '../ui/primitives.js';
import { AdminPageHeader } from './AdminDetailLayout.js';

const BRAND: Record<ConnectorKey, BrandName> = {
  gmail_sending: 'gmail',
  microsoft_sending: 'microsoft',
  agent_address: 'email',
  slack: 'slack',
  gmail_evidence: 'gmail',
};

function statusMark(connection: ConnectorStatus) {
  switch (connection.state) {
    case 'connected': return <StatusDot tone="ok" label="Connected" />;
    case 'paused': return <StatusDot tone="warn" label="Paused" />;
    case 'needs_attention': return <Pill tone="warn">Needs attention</Pill>;
    // Not connected: the Connect button says it (docs/DESIGN.md).
    default: return null;
  }
}

/** Two lines: where it stands (only what's worth reading), then what it can do. */
function description(connection: ConnectorStatus) {
  const definition = CONNECTORS.find((candidate) => candidate.key === connection.key);
  const standing = [
    connection.identity,
    connection.state === 'not_configured' ? 'Not available on this deployment' : connection.reason,
    connection.waiting > 0 ? `${connection.waiting} approved ${connection.waiting === 1 ? 'item' : 'items'} waiting` : null,
  ].filter(Boolean).join(' · ');
  const does = definition?.operations.map((operation) => operation.plain).join('. ') ?? '';
  return (
    <>
      {standing && <span className="admin-connection-standing">{standing}</span>}
      <span className="admin-connection-does">{does}.</span>
    </>
  );
}

export function AdminConnections() {
  const adapter = useAdapter();
  const state = useAppState();
  const nav = useNav();
  const [list, setList] = useState<ConnectorList | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void adapter.rest.connections(state.workspace.id).then(
      (loaded) => { if (live) setList(loaded); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [adapter, state.workspace.id]);

  if (failed) return <div className="admin-detail-page"><AdminPageHeader title="Connections" /><EmptyState icon="trace" title="Could not load connections" action={<Button onClick={() => window.location.reload()}>Reload</Button>} /></div>;
  if (!list) return <div className="admin-detail-page"><AdminPageHeader title="Connections" /><Skeleton rows={5} label="Loading connections" /></div>;

  // Services this deployment can't offer go last; they are facts, not actions.
  const ordered = [...list.connections].sort((a, b) => Number(a.state === 'not_configured') - Number(b.state === 'not_configured'));
  return (
    <div className="admin-detail-page">
      <AdminPageHeader title="Connections" />
      <div className="admin-connections" role="list" aria-label="Connections">
        {ordered.map((connection) => {
          const definition = CONNECTORS.find((candidate) => candidate.key === connection.key)!;
          const unavailable = connection.state === 'not_configured';
          const action = unavailable ? null
            : connection.state === 'not_connected' && definition.connect === 'admin_oauth' ? 'Connect'
              : connection.state === 'needs_attention' ? 'Review'
                : 'Open';
          return (
            <div role="listitem" key={connection.key} data-state={connection.state} className="admin-connection">
              <Item
                media={<BrandIcon name={BRAND[connection.key]} size={22} />}
                title={<><span>{definition.label}</span>{statusMark(connection)}</>}
                description={description(connection)}
                actions={action && list.can_manage
                  ? <Button primary={action === 'Review'} onClick={() => nav(ADMIN(connection.detail_view))}>{action}</Button>
                  : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
