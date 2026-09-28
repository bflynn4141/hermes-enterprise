import { useRef, useState, type ReactNode } from 'react';
import { ADMIN } from '@hermes/shared';
import { ADMIN_PAGES, ADMIN_SETTINGS_GROUPS } from '../../model/constants.js';
import { useNav } from '../store-context.js';
import { Icon } from '../ui/icons.js';
import { MenuItem, Popover } from '../ui/primitives.js';

const labelOf = (id: string): string => ADMIN_PAGES.find((page) => page.id === id)?.label ?? 'General';

/**
 * Every Admin page: its own address, one navigation, content at the top.
 *
 * Where the pane is wide enough the pages sit in a left rail, as in Vercel's
 * and Linear's settings. In the narrow side pane the rail would stack above
 * the page as a grid of links, so it becomes one menu button instead and the
 * page starts right under it (docs/DESIGN.md, Admin).
 */
export function AdminDetailLayout({ selected, children }: {
  selected: string;
  children: ReactNode;
}) {
  const nav = useNav();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const go = (id: string): void => { setOpen(false); nav(ADMIN(id)); };
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
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="admin-detail-switch">
        <button
          ref={anchor}
          type="button"
          className="admin-detail-switch-button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Admin pages. Current page: ${labelOf(selected)}`}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="list" size={16} />
          <span>Admin pages</span>
          <Icon name="chevron" size={14} />
        </button>
        <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="left" width={260} label="Admin pages" portal className="menu admin-detail-menu">
          {ADMIN_SETTINGS_GROUPS.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="admin-detail-menu-group">
              <p className="admin-detail-group-label">{group.label}</p>
              {group.items.map((item) => (
                <MenuItem key={item.id} role="menuitemradio" checked={selected === item.id} onClick={() => go(item.id)}>
                  {item.label}
                </MenuItem>
              ))}
            </div>
          ))}
        </Popover>
      </div>
      <section className="admin-settings-content" aria-label={labelOf(selected)}>
        {children}
      </section>
    </div>
  );
}

/**
 * One block of settings: a title, at most one sentence under it, the controls,
 * and a footer for the single action (Vercel's fieldset). Explanations longer
 * than a sentence do not belong here.
 */
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
