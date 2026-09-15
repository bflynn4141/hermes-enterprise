// The primitives the motion library has no equivalent for, kept and typed:
// Popover, Dialog, Disclosure, Tip, Avatar, Panel, MenuItem, formatWorked,
// fmtMoney (client-port spec §2, `ui/primitives.jsx` row).
//
// `Button` comes from `@hermes/motion-components`; the demo's own `Button`,
// `Chip`, `Toggle`, `Tabs`, `Ack` and `IrisMark` are kept here for now because
// the library's index exports only `Button`, `StreamText` and `Shimmer` — the
// atoms the spec lists (`Chip`, `StatusPill`, `SegmentedControl`, …) are built
// but not exported, and the library is not ours to edit (docs/DECISIONS, Client).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Glass, Icon } from './icons.js';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  primary?: boolean;
  quiet?: boolean;
  small?: boolean;
  link?: boolean;
}

export function Button({ primary, quiet, small, link, className = '', children, ...rest }: ButtonProps) {
  return (
    <button type="button" className={`btn ${primary ? 'primary' : ''} ${quiet ? 'quiet' : ''} ${small ? 'small' : ''} ${link ? 'link' : ''} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  name: string;
  label: string;
  size?: number;
  anchorRef?: RefObject<HTMLButtonElement | null>;
}

export function IconButton({ name, label, size = 18, className = '', anchorRef, ...rest }: IconButtonProps) {
  return (
    <Tip label={label}>
      <button ref={anchorRef} type="button" className={`icon-btn ${className}`} aria-label={label} {...rest}>
        <Icon name={name} size={size} />
      </button>
    </Tip>
  );
}

export interface PanelProps {
  icon?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  right?: ReactNode;
  className?: string;
  selected?: boolean;
  style?: CSSProperties;
}

export function Panel({ icon, title, subtitle, children, right, className = '', selected, style }: PanelProps) {
  return (
    <div className={`panel ${selected ? 'selected' : ''} ${className}`} style={style}>
      {icon && <Glass name={icon} size={28} className="panel-icon" />}
      <div className="panel-body">
        {title && <div className="panel-title">{title}</div>}
        {subtitle && <div className="panel-sub">{subtitle}</div>}
        {children}
      </div>
      {right}
    </div>
  );
}

export interface Tab {
  id: string;
  label: string;
  icon?: string;
}

export function Tabs({ tabs, value, onChange, strong, label }: { tabs: readonly Tab[]; value: string; onChange: (id: string) => void; strong?: boolean; label: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const wrap = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; width: number } | null>(null);
  const measure = useCallback(() => {
    const el = refs.current[value];
    const w = wrap.current;
    if (el && w) {
      const a = el.getBoundingClientRect();
      const b = w.getBoundingClientRect();
      setPos({ left: a.left - b.left, width: a.width });
    }
  }, [value]);
  useLayoutEffect(measure, [measure, tabs.length]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: string | null = null;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length]!.id;
    if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length]!.id;
    if (event.key === 'Home') next = tabs[0]!.id;
    if (event.key === 'End') next = tabs[tabs.length - 1]!.id;
    if (next) {
      event.preventDefault();
      onChange(next);
      refs.current[next]?.focus();
    }
  };
  return (
    <div className={`tabs ${strong ? 'strong' : ''}`} role="tablist" aria-label={label} ref={wrap}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          ref={(el) => {
            refs.current[tab.id] = el;
          }}
          aria-selected={value === tab.id}
          className="tab"
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {tab.icon && <Glass name={tab.icon} size={20} />}
          {tab.label}
        </button>
      ))}
      {pos && <motion.div className="tab-indicator" aria-hidden="true" initial={false} animate={{ left: pos.left, width: pos.width }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }} />}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="knob" />
    </button>
  );
}

export function Chip({ icon = 'context', children, onRemove, onClick, removeLabel }: { icon?: string; children: ReactNode; onRemove?: () => void; onClick?: () => void; removeLabel?: string }) {
  const inner = (
    <>
      {icon && <Glass name={icon} size={18} />}
      <span className="truncate">{children}</span>
    </>
  );
  return (
    <span className="chip">
      {onClick ? (
        <button type="button" onClick={onClick} className="row" style={{ gap: 8 }}>
          {inner}
        </button>
      ) : (
        inner
      )}
      {onRemove && (
        <button type="button" className="x" aria-label={removeLabel ?? 'Remove'} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}

/** Grid-rows disclosure; content is inert when closed. */
export function Disclosure({ open, children, id }: { open: boolean; children: ReactNode; id?: string }) {
  return (
    <div className="disclosure" data-open={open} id={id}>
      <div className="disclosure-inner" inert={!open} aria-hidden={!open}>
        {children}
      </div>
    </div>
  );
}

export function IrisMark({ state = 'static', size = 26, className = '' }: { state?: string; size?: number; className?: string }) {
  return (
    <span className={`iris-motion ${className}`} data-state={state} style={{ width: size, height: size }} aria-hidden="true">
      <span className="halo" />
      <span className="orbit">
        <i />
      </span>
      <Glass name="iris" size={Math.round(size * 0.83)} className="glyph" />
    </span>
  );
}

export interface PersonLike {
  name?: string;
  initials?: string;
  avatar?: string;
}

export function Avatar({ person, size = 28 }: { person?: PersonLike | null; size?: number }) {
  const initials = person?.initials ?? (person?.name ? person.name.split(' ').map((p) => p[0]).slice(0, 2).join('') : '?');
  if (person?.avatar) return <img className={`avatar ${size >= 40 ? 'lg' : ''}`} src={person.avatar} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  return (
    <span className={`avatar ${size >= 40 ? 'lg' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      {initials}
    </span>
  );
}

/** 150 ms in, instant out, 80 ms show delay, anchored above. */
export function Tip({ label, children }: { label: string; children: ReactNode }) {
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const reduce = useReducedMotion();
  const open = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setPos({ left: rect.left + rect.width / 2, top: rect.top - 8 });
      setShow(true);
    }, 80);
  };
  const close = (): void => {
    if (timer.current) clearTimeout(timer.current);
    setShow(false);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <span ref={anchor} onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close} style={{ display: 'inline-flex' }}>
      {children}
      <AnimatePresence>
        {show && pos && (
          <motion.span
            role="tooltip"
            className="tooltip"
            style={{ position: 'fixed', left: pos.left, top: pos.top, transform: 'translate(-50%,-100%)' }}
            initial={{ opacity: 0, scale: reduce ? 1 : 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.05 } }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  align?: 'left' | 'right';
  width?: number;
  className?: string;
  label: string;
  offset?: number;
  above?: boolean;
}

export function Popover({ open, onClose, anchorRef, children, align = 'right', width, className = '', label, offset = 8, above = false }: PopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const latest = useRef({ onClose, anchorRef });
  latest.current = { onClose, anchorRef };
  useEffect(() => {
    if (!open) return;
    const close = (): void => latest.current.onClose();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    const onClick = (event: MouseEvent): void => {
      const anchor = latest.current.anchorRef.current;
      const target = event.target as Node;
      if (panel.current && !panel.current.contains(target) && !(anchor && anchor.contains(target))) close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onClick);
    const first = panel.current?.querySelector<HTMLElement>('input,button:not([disabled]),[tabindex="0"]');
    first?.focus({ preventScroll: true });
    const returnTo = latest.current.anchorRef.current;
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onClick);
      if (returnTo && (document.activeElement === document.body || panel.current?.contains(document.activeElement))) (returnTo as HTMLElement).focus({ preventScroll: true });
    };
  }, [open]);
  const style: CSSProperties = { width, [align === 'right' ? 'right' : 'left']: 0, ...(above ? { bottom: `calc(100% + ${offset}px)` } : { top: `calc(100% + ${offset}px)` }) };
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panel}
          className={`popover ${className}`}
          role="dialog"
          aria-label={label}
          style={style}
          initial={{ opacity: 0, y: reduce ? 0 : above ? 4 : -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export interface MenuItemProps {
  children: ReactNode;
  sub?: ReactNode;
  checked?: boolean;
  icon?: string;
  onClick?: () => void;
  disabled?: boolean;
  small?: boolean;
  right?: ReactNode;
  title?: string;
}

export function MenuItem({ children, sub, checked, icon, onClick, disabled, small, right, title }: MenuItemProps) {
  return (
    <button type="button" className={`menu-item ${small ? 'small' : ''}`} role={checked !== undefined ? 'menuitemradio' : 'menuitem'} aria-checked={checked} onClick={onClick} disabled={disabled} title={title}>
      {icon && <Icon name={icon} />}
      <span className="mi-body">
        <span>{children}</span>
        {sub && <span className="mi-sub">{sub}</span>}
      </span>
      {checked && (
        <span className="mi-check" aria-hidden="true">
          ✓
        </span>
      )}
      {right}
    </button>
  );
}

/** One restrained acknowledgement, shown only after success. */
export function Ack({ show, children, style }: { show: boolean; children: ReactNode; style?: CSSProperties }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {show && (
        <motion.span className="ack-chip" role="status" style={style} initial={{ opacity: 0, y: reduce ? 0 : 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
          {children}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

export function Dialog({ open, title, children, actions, onClose }: { open: boolean; title: string; children: ReactNode; actions?: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector('button')?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') latest.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div className="dialog-card" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
            <h2 className="display-26">{title}</h2>
            <div className="col" style={{ gap: 12 }}>
              {children}
            </div>
            <div className="dialog-actions">{actions}</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function useToast(): [(text: string) => void, ReactNode] {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(text);
    timer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  const node = (
    <AnimatePresence>
      {toast && (
        <motion.div className="toast" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
          {toast}
        </motion.div>
      )}
    </AnimatePresence>
  );
  return [show, node];
}

export function formatWorked(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `Worked ${seconds}s` : `Worked ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const fmtMoney = (minor: number): string => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: minor % 100 === 0 ? 0 : 2 })}`;

// ---------------------------------------------------------------------------
// Loading and empty states
// ---------------------------------------------------------------------------

/**
 * The 300 ms skeleton. A cache miss renders this, never "not found": the
 * session socket can name an entity the workspace socket has not delivered yet,
 * and the fetch that answers it usually lands inside the 300 ms (spec §4.4.2).
 */
export function Skeleton({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const handle = setTimeout(() => setVisible(true), 300);
    return () => clearTimeout(handle);
  }, []);
  if (!visible) return <div className="skeleton-hold" aria-busy="true" aria-label={label} />;
  return (
    <div className="skeleton" aria-busy="true" aria-label={label} role="status">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton-row" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ icon = 'context', title, detail, action }: { icon?: string; title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Glass name={icon} size={48} className="icon" />
      <div style={{ color: 'var(--body)', fontSize: 18 }}>{title}</div>
      {detail && <div className="meta">{detail}</div>}
      {action}
    </div>
  );
}

/** A block that failed contract validation. Shown, logged, never thrown. */
export function BrokenBlock({ reason }: { reason?: string }) {
  return (
    <div className="error-block" role="note">
      <div className="t">Could not display this block</div>
      {reason && <div className="s">{reason}</div>}
    </div>
  );
}
