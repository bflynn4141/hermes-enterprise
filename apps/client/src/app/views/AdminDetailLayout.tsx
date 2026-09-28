import type { ReactNode } from 'react';
import { ADMIN } from '@hermes/shared';
import { ADMIN_SETTINGS_GROUPS, adminSectionOf } from '../../model/constants.js';
import { useNav } from '../store-context.js';
import { BrandIcon, type BrandName } from '../ui/brand-icons.js';
import { Pill, Tabs } from '../ui/primitives.js';

/**
 * Every Admin page: its own address, its section in the rail, its siblings as
 * tabs above the content, as on the Agent page (docs/DESIGN.md, Admin).
 *
 * The rail names only the three sections. Where the pane is too narrow for a
 * rail, the sections become a row of tabs of their own.
 */
export function AdminDetailLayout({ selected, children }: {
  selected: string;
  children: ReactNode;
}) {
  const nav = useNav();
  const section = adminSectionOf(selected);
  const openSection = (label: string): void => {
    const next = ADMIN_SETTINGS_GROUPS.find((group) => group.label === label);
    if (next && next !== section) nav(ADMIN(next.items[0].id));
  };
  return (
    <div className="admin-detail-layout">
      <nav className="admin-detail-index" aria-label="Admin settings">
        {ADMIN_SETTINGS_GROUPS.map((group) => (
          <button
            type="button"
            key={group.label}
            aria-current={group === section ? 'page' : undefined}
            onClick={() => openSection(group.label)}
          >
            {group.label}
          </button>
        ))}
      </nav>
      <div className="admin-detail-sections">
        <Tabs
          strong
          tabs={ADMIN_SETTINGS_GROUPS.map((group) => ({ id: group.label, label: group.label }))}
          value={section.label}
          onChange={openSection}
          label="Admin sections"
        />
      </div>
      <section className="admin-settings-content" aria-label={section.items.find((item) => item.id === selected)?.label ?? section.label}>
        <div className="admin-detail-tabs">
          <Tabs
            tabs={section.items.map((item) => ({ id: item.id, label: item.label, ...('brand' in item ? { brand: item.brand } : {}) }))}
            value={selected}
            onChange={(id) => nav(ADMIN(id))}
            label={`${section.label} pages`}
          />
        </div>
        {children}
      </section>
    </div>
  );
}

/**
 * The top of an Admin page. The page's tab already names it, so the title is
 * for screen readers, and there is no slot for a description: a sentence
 * floating under the tabs is the text this layout exists to remove
 * (docs/DESIGN.md, Admin). Actions sit on their own row, right-aligned.
 */
export function AdminPageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  if (!actions) return <h2 className="sr-only">{title}</h2>;
  return (
    <header className="admin-page-header">
      <h2 className="sr-only">{title}</h2>
      {actions}
    </header>
  );
}

/**
 * A connection's state, when it is worth reading. "Not connected" is what the
 * Connect button already says, so it has no badge; a healthy connection is a
 * quiet line, and only one that needs someone gets a pill (docs/DESIGN.md,
 * Connections).
 */
export type ConnectionBadge = { label: 'Connected' | 'Needs attention'; tone: 'ok' | 'warn' };

/**
 * One block of settings: a title, at most one sentence under it, the controls,
 * and a footer for the single action (Vercel's fieldset). Explanations longer
 * than a sentence do not belong here. A connection's card carries the service's
 * logo and, once there is something to say, its state beside the title.
 */
export function AdminSettingsCard({ title, description, children, footer, danger = false, brand, badge }: {
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  danger?: boolean;
  brand?: BrandName;
  badge?: ConnectionBadge | null;
}) {
  return (
    <section className={`admin-settings-card${danger ? ' admin-settings-card-danger' : ''}`} aria-label={title}>
      <header className={`admin-settings-card-header${brand ? ' with-brand' : ''}`}>
        {brand && <BrandIcon name={brand} size={28} />}
        <div className="admin-settings-card-heading">
          <div className="admin-settings-card-title"><h3>{title}</h3>{badge && (badge.tone === 'ok'
            ? <span className="connection-ok">{badge.label}</span>
            : <Pill tone={badge.tone}>{badge.label}</Pill>)}</div>
          {description && <p>{description}</p>}
        </div>
      </header>
      {children && <div className="admin-settings-card-body">{children}</div>}
      {footer && <footer className="admin-settings-card-footer">{footer}</footer>}
    </section>
  );
}
