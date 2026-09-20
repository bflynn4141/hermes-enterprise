import { useId } from 'react';
import { cloudConnectionPresentation, type CloudConnectionStatus } from '../../model/cloud-connection.js';
import './cloud-connection.css';

export interface CloudConnectionProps {
  status: CloudConnectionStatus;
  available: boolean;
  busy: boolean;
  /** Safe user-facing copy; map provider errors before passing them here. */
  error: string | null;
  onConnect: () => void;
}

export function CloudConnection({ status, available, busy, error, onConnect }: CloudConnectionProps) {
  const headingId = useId();
  const descriptionId = useId();
  const presentation = cloudConnectionPresentation(status);
  // A saved connection is not proof that its organization has been verified.
  const organizationName = status.status === 'connected' ? status.organization_name : null;

  return (
    <section className="cloud-connection" aria-labelledby={headingId}>
      <div className="cloud-connection-main">
        <div className="cloud-connection-heading">
          <h3 id={headingId}>Cloud</h3>
          <span className="cloud-connection-status" data-tone={presentation.tone} role="status">
            <span aria-hidden="true" className="cloud-connection-dot" />
            {presentation.label}
          </span>
        </div>
        {organizationName && <p className="cloud-connection-organization">{organizationName}</p>}
        <p id={descriptionId} className="cloud-connection-description">{presentation.description}</p>
        {!available && presentation.action && <p className="cloud-connection-note">Cloud connection is not available yet.</p>}
        {error && <p className="cloud-connection-error" role="alert">{error}</p>}
      </div>
      {presentation.action && (
        <button
          type="button"
          className="btn primary cloud-connection-action"
          disabled={!available || busy}
          aria-describedby={descriptionId}
          aria-busy={busy}
          onClick={onConnect}
        >
          {busy ? 'Opening Cloud…' : presentation.action}
        </button>
      )}
    </section>
  );
}
