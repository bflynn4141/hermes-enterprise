import type { ReactNode } from 'react';
import { ADMIN } from '@hermes/shared';
import { ADMIN_SETTINGS_GROUPS } from '../../model/constants.js';
import { useNav } from '../store-context.js';

function pageLabel(id: string, label: string): string {
  return id === 'Organization' ? 'Workspace details' : label;
}

/** One left rail for every Admin page — no stacked tab rows. */
export function AdminDetailLayout({ selected, children }: {
  selected: string;
  children: ReactNode;
}) {
  const nav = useNav();
  return (
    <div className="admin-detail-layout">
      <nav className="admin-detail-index" aria-label="Admin settings">
        {ADMIN_SETTINGS_GROUPS.map((group) => (
          <div key={group.label} className="admin-detail-group">
            <p className="admin-detail-group-label">{group.label}</p>
            <div className="admin-detail-group-items">
              {group.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-current={selected === item.id ? 'page' : undefined}
                  onClick={() => nav(ADMIN(item.id))}
                >
                  {pageLabel(item.id, item.label)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <section className="admin-settings-content" aria-label="Admin settings content">
        {children}
      </section>
    </div>
  );
}

export function AdminSettingsCard({ title, description, children, footer, danger = false }: {
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  danger?: boolean;
}) {
  return (
    <section className={`admin-settings-card${danger ? ' admin-settings-card-danger' : ''}`} aria-label={title}>
      <header className="admin-settings-card-header">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </header>
      {children && <div className="admin-settings-card-body">{children}</div>}
      {footer && <footer className="admin-settings-card-footer">{footer}</footer>}
    </section>
  );
}
