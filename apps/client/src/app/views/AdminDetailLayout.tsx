import type { ReactNode } from 'react';
import { ADMIN } from '@hermes/shared';
import { useNav } from '../store-context.js';

/** The top-level tabs stay fixed; this index selects one complete settings page. */
export function AdminDetailLayout({ group, items, selected, children }: {
  group: string;
  items: readonly { id: string; label: string }[];
  selected: string;
  children: ReactNode;
}) {
  const nav = useNav();
  return (
    <div className={`admin-detail-layout${items.length === 1 ? ' admin-detail-layout-single' : ''}`}>
      {items.length > 1 && (
        <nav className="admin-detail-index" aria-label={`${group} settings pages`}>
          {items.map((item) => (
            <button type="button" key={item.id} aria-current={selected === item.id ? 'page' : undefined} onClick={() => nav(ADMIN(item.id))}>
              {item.id === 'Organization' ? 'Workspace details' : item.label}
            </button>
          ))}
        </nav>
      )}
      <section className="admin-settings-content" aria-label={`${group} admin settings`}>
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
