/* Adapted from Beautiful UI. Copyright (c) 2026 Shane Levine. MIT License; see LICENSE.beautiful-ui. */
"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "../../lib/motion";


// Bundled Hermes marks; no host-root asset path is required.
const IRIS_ASSET = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22face%22%20x1%3D%2210%22%20y1%3D%227%22%20x2%3D%2249%22%20y2%3D%2260%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%23FFFFFF%22/%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23E9E6F6%22/%3E%3Cstop%20offset%3D%22.72%22%20stop-color%3D%22%23BDB7D8%22/%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23716B96%22/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg%20opacity%3D%22.2%22%20transform%3D%22translate%280%203%29%22%3E%3Cpath%20d%3D%22M32%209C38%209%2042%2017%2038%2024C45%2020%2053%2024%2053%2031C53%2038%2045%2042%2038%2038C42%2045%2038%2053%2031%2053C24%2053%2020%2045%2024%2038C17%2042%209%2038%209%2031C9%2024%2017%2020%2024%2024C20%2017%2024%209%2032%209Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M32%2010C36%2010%2040%2015%2039%2021L32%2030%2025%2023C22%2017%2025%2010%2032%2010Z%22%20fill%3D%22%23FFF%22%20opacity%3D%22.72%22/%3E%3Cpath%20d%3D%22M33%2032%2048%2026C55%2034%2046%2042%2039%2038L34%2049%2028%2038Z%22%20fill%3D%22%239E9ABF%22%20opacity%3D%22.38%22/%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2231%22%20r%3D%226%22%20fill%3D%22%2326214C%22/%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2230%22%20r%3D%225%22%20fill%3D%22%23181333%22/%3E%3C/g%3E%3Cpath%20d%3D%22M32%209C38%209%2042%2017%2038%2024C45%2020%2053%2024%2053%2031C53%2038%2045%2042%2038%2038C42%2045%2038%2053%2031%2053C24%2053%2020%2045%2024%2038C17%2042%209%2038%209%2031C9%2024%2017%2020%2024%2024C20%2017%2024%209%2032%209Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M32%2010C36%2010%2040%2015%2039%2021L32%2030%2025%2023C22%2017%2025%2010%2032%2010Z%22%20fill%3D%22%23FFF%22%20opacity%3D%22.72%22/%3E%3Cpath%20d%3D%22M33%2032%2048%2026C55%2034%2046%2042%2039%2038L34%2049%2028%2038Z%22%20fill%3D%22%239E9ABF%22%20opacity%3D%22.38%22/%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2231%22%20r%3D%226%22%20fill%3D%22%2326214C%22/%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2230%22%20r%3D%225%22%20fill%3D%22%23181333%22/%3E%3C/svg%3E";
const SKILL_ASSET = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22face%22%20x1%3D%2210%22%20y1%3D%227%22%20x2%3D%2249%22%20y2%3D%2260%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%23FFFFFF%22/%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23E9E6F6%22/%3E%3Cstop%20offset%3D%22.72%22%20stop-color%3D%22%23BDB7D8%22/%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23716B96%22/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg%20opacity%3D%22.2%22%20transform%3D%22translate%280%203%29%22%3E%3Cpath%20d%3D%22m32%203%209%2020%2020%209-20%209-9%2020-9-20L3%2032l20-9Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22m32%203%200%2029L3%2032l20-9Z%22%20fill%3D%22%23FFF%22%20opacity%3D%22.8%22/%3E%3Cpath%20d%3D%22m32%2032%2029%200-20%209-9%2020Z%22%20fill%3D%22%238B86AD%22%20opacity%3D%22.54%22/%3E%3Cpath%20d%3D%22m32%2032%209-9%2020%209Z%22%20fill%3D%22%23F9F6FF%22%20opacity%3D%22.7%22/%3E%3C/g%3E%3Cpath%20d%3D%22m32%203%209%2020%2020%209-20%209-9%2020-9-20L3%2032l20-9Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22m32%203%200%2029L3%2032l20-9Z%22%20fill%3D%22%23FFF%22%20opacity%3D%22.8%22/%3E%3Cpath%20d%3D%22m32%2032%2029%200-20%209-9%2020Z%22%20fill%3D%22%238B86AD%22%20opacity%3D%22.54%22/%3E%3Cpath%20d%3D%22m32%2032%209-9%2020%209Z%22%20fill%3D%22%23F9F6FF%22%20opacity%3D%22.7%22/%3E%3C/svg%3E";
const INBOX_ASSET = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22face%22%20x1%3D%2210%22%20y1%3D%227%22%20x2%3D%2249%22%20y2%3D%2260%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%23FFFFFF%22/%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23E9E6F6%22/%3E%3Cstop%20offset%3D%22.72%22%20stop-color%3D%22%23BDB7D8%22/%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23716B96%22/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg%20opacity%3D%22.2%22%20transform%3D%22translate%280%203%29%22%3E%3Cpath%20d%3D%22M15%2013h34l10%2027v17H5V40Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M15%2013h34l8%2024H40l-4%207h-8l-4-7H7Z%22%20fill%3D%22%23D2CDE7%22/%3E%3Cpath%20d%3D%22M5%2040h19l4%207h8l4-7h19v17H5Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M15%2014h34%22%20stroke%3D%22%23FFF%22%20stroke-width%3D%222%22/%3E%3C/g%3E%3Cpath%20d%3D%22M15%2013h34l10%2027v17H5V40Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M15%2013h34l8%2024H40l-4%207h-8l-4-7H7Z%22%20fill%3D%22%23D2CDE7%22/%3E%3Cpath%20d%3D%22M5%2040h19l4%207h8l4-7h19v17H5Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M15%2014h34%22%20stroke%3D%22%23FFF%22%20stroke-width%3D%222%22/%3E%3C/svg%3E";

// Authored interface glyphs; Hermes glass assets carry the workspace identity.
function Glyph({ path, size = 18, className = "" }: { path: string; size?: number; className?: string }) {
  return <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
const IconArrowBoxLeft = (props: { size?: number }) => <Glyph {...props} path="M10 5H5v14h5 M15 8l-4 4 4 4 M11 12h10" />;
const IconCheckmark1Small = (props: { size?: number }) => <Glyph {...props} path="m5 12 4 4 10-10" />;
const IconChevronDownSmall = (props: { size?: number }) => <Glyph {...props} path="m7 10 5 5 5-5" />;
const IconCrossSmall = (props: { size?: number }) => <Glyph {...props} path="m6 6 12 12 M18 6 6 18" />;
const IconEditBig = (props: { size?: number }) => <Glyph {...props} path="m14 5 5 5 M5 19l4-1L20 7l-4-4L5 14Z" />;
const IconHome = (props: { size?: number }) => <Glyph {...props} path="m3 10 9-7 9 7 M5 9v11h14V9 M10 20v-7h4v7" />;
const IconMagnifyingGlass = (props: { size?: number }) => <Glyph {...props} path="M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l6 6" />;
const IconPlusMedium = (props: { size?: number }) => <Glyph {...props} path="M12 5v14 M5 12h14" />;
const IconSettingsGear1 = (props: { size?: number }) => <Glyph {...props} path="M5 6h14 M5 12h14 M5 18h14 M9 3v6 M15 9v6 M9 15v6" />;
const IconSidebarLeftArrow = (props: { size?: number; className?: string }) => <Glyph {...props} path="M3 4h18v16H3Z M9 4v16 m8-12-4 4 4 4" />;
const IconUserAdd = (props: { size?: number }) => <Glyph {...props} path="M12 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M3 20v-3a6 6 0 0 1 12 0v3 M19 7v8 M15 11h8" />;
import GlideMenu from "./GlideMenu";

/* ─────────────────────────────────────────────────────────
 * SIDEBAR NAV
 * Shared by the design-system preview and the harness shell:
 * compact workspace switcher, primary navigation, searchable
 * chat history, and a collapse that preserves icon alignment.
 * ───────────────────────────────────────────────────────── */

const WORKSPACE = { key: "nous", name: "Nous Research", monogram: "N" };

const NAV_ITEMS = [
  { key: "overview", label: "Overview", icon: <IconHome size={18} />, count: undefined },
  { key: "inbox", label: "Inbox", icon: <img src={INBOX_ASSET} width="18" height="18" alt="" />, count: "4" },
  { key: "members", label: "Members", icon: <IconUserAdd size={18} />, count: undefined },
  { key: "skills", label: "Shared skills", icon: <img src={SKILL_ASSET} width="18" height="18" alt="" />, count: undefined },
];

export type SidebarRecent = {
  id: string;
  label: string;
  prompt?: string;
};

const DEFAULT_RECENTS: SidebarRecent[] = [
  { id: "screening", label: "Screen partner applications" },
  { id: "prospects", label: "Find new partners" },
  { id: "readiness", label: "Check partner readiness" },
  { id: "guide", label: "Update onboarding guide" },
  { id: "feedback", label: "Summarize partner feedback" },
];

export type SidebarNavProps = {
  workspace?: { key: string; name: string; monogram: string };
  navItems?: { key: string; label: string; icon: ReactNode; count?: string }[];
  onWorkspaceAction?: (action: string) => void;
  activeTitle?: string | null;
  className?: string;
  fill?: boolean;
  onNewChat?: () => void;
  onPick?: (id: string, label: string, prompt?: string) => void;
  /** controlled primary-nav selection (e.g. "home" | "invite") */
  activeNav?: string;
  onNavigate?: (key: string) => void;
  /** Footer identity / settings entry. */
  footerLabel?: string;
  footerIcon?: ReactNode;
  onFooterClick?: () => void;
  recents?: SidebarRecent[];
  variant?: string;
};

const SIDEBAR_MOTION = {
  expandedWidth: 224,
  collapsedWidth: 52,
  duration: 280,
  copyDuration: 180,
  copyOffset: 8,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

/* ─────────────────────────────────────────────────────────
 * CHAT SEARCH STORYBOARD
 *
 *   0ms   search is triggered; Chats label begins fading
 *   0ms   field grows right → left from the search control
 * 180ms   field fills the row; cursor is focused and ready
 * ───────────────────────────────────────────────────────── */
const CHAT_SEARCH_MOTION = {
  duration: 180,
  closedWidth: 28,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

function GlideGroup({ children }: { children: ReactNode }) {
  return (
    <GlideMenu
      rowSelector="[data-row]"
      highlightClassName="sidebar-glide-highlight rounded-[7px] bg-hover-2"
      className="group/glide flex flex-col gap-px"
    >
      {children}
    </GlideMenu>
  );
}

function RailButton({
  icon,
  label,
  active = false,
  count,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  count?: string;
  onClick?: () => void;
}) {
  return (
    <button
      data-row
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left
        transition-[width,background-color,color,transform] duration-150 active:scale-[0.98]
        ${active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""}`}
    >
      <span className={`flex size-5 shrink-0 items-center justify-center ${active ? "text-ink" : "text-ink-2"}`}>
        {icon}
      </span>
      <span className={`sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium ${active ? "text-ink" : "text-ink-2"}`}>
        {label}
      </span>
      {count && (
        <span className="sidebar-copy mr-2 shrink-0 text-[12px] font-medium tabular-nums text-ink-3">
          {count}
        </span>
      )}
    </button>
  );
}

function WorkspaceMenu({
  position,
  onClose,
  workspace,
  onAction,
}: {
  position: { top: number; left: number };
  onClose: () => void;
  workspace: { name: string; monogram: string };
  onAction?: (action: string) => void;
}) {
  const reduce = useReducedMotion();
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);
  return createPortal(
    <div
      data-workspace-menu
      ref={menuRef}
      data-reduced-motion={reduce}
      className="hermes-ui fixed z-50 w-64 rounded-[14px] bg-surface p-1.5 shadow-overlay"
      style={{
        top: position.top,
        left: position.left,
        animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both",
        transformOrigin: "top left",
      }}
    >
      <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[8px] bg-hover-2">
        <button
          data-menu-row
          type="button"
          onClick={onClose}
          className="relative z-10 flex h-10 w-full items-center gap-1.5 rounded-[8px] px-2 text-left"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-ink text-[11px] font-semibold text-surface">
            {workspace.monogram}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{workspace.name}</span>
          <span className="shrink-0 text-ink"><IconCheckmark1Small size={18} /></span>
        </button>
        <div className="my-1 h-px bg-line" />
        {[
          { label: "Switch workspace", icon: <IconPlusMedium size={16} /> },
          { label: "Workspace settings", icon: <IconSettingsGear1 size={16} /> },
          { label: "Invite team members", icon: <IconUserAdd size={16} /> },
        ].map((item) => (
          <button
            key={item.label}
            data-menu-row
            type="button"
            onClick={() => { onAction?.(item.label); onClose(); }}
            className="relative z-10 flex h-9 w-full items-center gap-1.5 rounded-[8px] px-2 text-left"
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">{item.icon}</span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{item.label}</span>
          </button>
        ))}

      </GlideMenu>
    </div>,
    document.body,
  );
}

export default function SidebarNav({
  activeTitle,
  className = "",
  fill = false,
  onNewChat,
  onPick,
  activeNav,
  onNavigate,
  footerLabel = "Maya Chen",
  footerIcon,
  onFooterClick,
  recents = DEFAULT_RECENTS,
  workspace = WORKSPACE,
  navItems = NAV_ITEMS,
  onWorkspaceAction,
}: SidebarNavProps = {}) {
  const reduce = useReducedMotion();
  const [collapsed, setCollapsed] = useState(false);
  const [internalNav, setInternalNav] = useState("chats");
  const currentNav = activeNav ?? internalNav;
  const selectNav = (key: string) => {
    setInternalNav(key);
    onNavigate?.(key);
  };
  const [demoActiveTitle, setDemoActiveTitle] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspacePosition, setWorkspacePosition] = useState({ top: 0, left: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedTitle = activeTitle === undefined ? demoActiveTitle : activeTitle;
  const visibleRecents = recents.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (!workspaceOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest("[data-workspace-trigger]") && !target.closest("[data-workspace-menu]")) {
        setWorkspaceOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setWorkspaceOpen(false); workspaceButtonRef.current?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [workspaceOpen]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const collapse = () => {
    setCollapsed(true);
    setWorkspaceOpen(false);
    setSearchOpen(false);
    setQuery("");
  };

  return (
    <aside
      data-sidebar-collapsed={collapsed}
      aria-label="Workspace navigation"
      className={`relative flex shrink-0 overflow-hidden transition-[width] ${fill ? "h-full" : "h-[600px]"} ${className}`}
      style={{
        width: collapsed ? SIDEBAR_MOTION.collapsedWidth : SIDEBAR_MOTION.expandedWidth,
        transitionDuration: reduce ? "0ms" : `${SIDEBAR_MOTION.duration}ms`,
        transitionTimingFunction: SIDEBAR_MOTION.easing,
        "--sidebar-copy-duration": reduce ? "0ms" : `${SIDEBAR_MOTION.copyDuration}ms`,
        "--sidebar-copy-offset": `${SIDEBAR_MOTION.copyOffset}px`,
        "--sidebar-easing": SIDEBAR_MOTION.easing,
      } as CSSProperties}
    >
      <div className="flex min-h-0 w-[224px] shrink-0 flex-col">
        <div className="relative mb-2.5 h-10 shrink-0">
          <button
            ref={workspaceButtonRef}
            data-workspace-trigger
            type="button"
            aria-expanded={workspaceOpen}
            aria-hidden={collapsed}
            tabIndex={collapsed ? -1 : 0}
            onClick={() => {
              if (!workspaceOpen && workspaceButtonRef.current) {
                const rect = workspaceButtonRef.current.getBoundingClientRect();
                setWorkspacePosition({ top: Math.min(rect.bottom + 6, window.innerHeight - 220), left: Math.max(8, Math.min(rect.left, window.innerWidth - 264)) });
              }
              setWorkspaceOpen((open) => !open);
            }}
            className="sidebar-workspace-control absolute left-2 top-1 flex h-8 w-[164px] items-center rounded-[8px] px-2 text-left transition-[background-color,transform] duration-100 hover:bg-hover-2 active:scale-[0.99]"
          >
            <span className="sidebar-logo flex size-5 shrink-0 items-center justify-center text-ink">
              <img src={IRIS_ASSET} width="20" height="20" alt="" />
            </span>
            <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink-2">
              {workspace.name}
            </span>
            <span className="sidebar-copy ml-1 flex shrink-0 text-ink-3">
              <IconChevronDownSmall size={16} />
            </span>
          </button>

          {workspaceOpen && <WorkspaceMenu position={workspacePosition} workspace={workspace} onAction={onWorkspaceAction} onClose={() => { setWorkspaceOpen(false); workspaceButtonRef.current?.focus(); }} />}

          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-hidden={collapsed}
            tabIndex={collapsed ? -1 : 0}
            onClick={collapse}
            className="sidebar-collapse-control absolute right-2 top-1 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <IconSidebarLeftArrow size={18} />
          </button>
          <button
            type="button"
            aria-label="Expand sidebar"
            aria-hidden={!collapsed}
            tabIndex={collapsed ? 0 : -1}
            onClick={() => setCollapsed(false)}
            className="sidebar-expand-control absolute left-2 top-0.5 flex size-9 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <IconSidebarLeftArrow size={18} className="rotate-180" />
          </button>
        </div>

        <GlideGroup>
          <RailButton
            icon={<IconEditBig size={18} />}
            label="New session"
            onClick={() => {
              if (activeTitle === undefined) setDemoActiveTitle(null);
              selectNav("chats");
              onNewChat?.();
            }}
          />
          {navItems.map((item) => (
            <RailButton
              key={item.key}
              icon={item.icon}
              label={item.label}
              count={item.count}
              active={currentNav === item.key}
              onClick={() => selectNav(item.key)}
            />
          ))}
        </GlideGroup>

        <div inert={collapsed} className="mt-3 min-h-0 flex-1 overflow-y-auto">
          <div className="sidebar-copy relative mx-2 mb-1 h-8">
            <div
              aria-hidden={searchOpen}
              className={`absolute inset-0 flex items-center gap-1.5 px-2 text-[12.5px] font-medium text-ink-3 transition-[opacity,transform] ${searchOpen ? "pointer-events-none -translate-x-1 opacity-0" : "translate-x-0 opacity-100"}`}
              style={{ transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`, transitionTimingFunction: CHAT_SEARCH_MOTION.easing }}
            >
              <IconChevronDownSmall size={16} />
              <span>Iris sessions</span>
            </div>

            <button
              type="button"
              aria-label="Search sessions"
              aria-expanded={searchOpen}
              tabIndex={searchOpen ? -1 : 0}
              onClick={() => setSearchOpen(true)}
              className={`absolute right-0 top-0 z-10 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color,transform] hover:bg-hover-2 hover:text-ink active:scale-[0.96] ${searchOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}
              style={{ transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms` }}
            >
              <IconMagnifyingGlass size={16} />
            </button>

            <div
              className={`absolute right-0 top-0 z-20 flex h-8 items-center overflow-hidden rounded-[8px] bg-field text-ink-3 shadow-hairline transition-[width,opacity] focus-within:text-ink-2 ${searchOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
              style={{
                width: searchOpen ? "100%" : CHAT_SEARCH_MOTION.closedWidth,
                transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`,
                transitionTimingFunction: CHAT_SEARCH_MOTION.easing,
              }}
            >
              <span className="ml-2 flex shrink-0 items-center justify-center">
                <IconMagnifyingGlass size={15} />
              </span>
              <input
                ref={searchRef}
                tabIndex={searchOpen ? 0 : -1}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearchOpen(false);
                    setQuery("");
                  }
                }}
                placeholder="Search sessions"
                aria-label="Search session history"
                className="ml-1.5 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-3"
              />
              <button
                type="button"
                aria-label="Close session search"
                tabIndex={searchOpen ? 0 : -1}
                onClick={() => {
                  setSearchOpen(false);
                  setQuery("");
                }}
                className="flex size-8 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]"
              >
                <IconCrossSmall size={16} />
              </button>
            </div>
          </div>

          <GlideGroup>
            {visibleRecents.map((item) => {
              const active = item.label === selectedTitle;
              return (
                <button
                  key={item.id}
                  data-row
                  type="button"
                  title={item.label}
                  onClick={() => {
                    selectNav("chats");
                    if (activeTitle === undefined) setDemoActiveTitle(item.label);
                    onPick?.(item.id, item.label, item.prompt);
                  }}
                  className={`sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${
                    active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""
                  }`}
                >
                  <span className={`sidebar-copy min-w-0 flex-1 truncate text-[14px] font-medium ${active ? "text-ink" : "text-ink-2"}`}>
                    {item.label}
                  </span>
                </button>
              );
            })}
            {query && visibleRecents.length === 0 && (
              <div className="sidebar-copy mx-2 px-2 py-2 text-[12.5px] text-ink-3">No sessions found</div>
            )}
          </GlideGroup>
        </div>

        <div inert={collapsed} className="sidebar-copy mx-2 mt-3 w-[208px] border-t border-line pt-3">
          <button
            type="button"
            onClick={onFooterClick ?? (() => selectNav("settings"))}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-control bg-hover-2 text-[12.5px] font-medium text-ink transition-[background-color,transform] duration-150 hover:bg-line-strong active:scale-[0.98]"
          >
            {footerIcon}
            {footerLabel}
          </button>
        </div>
      </div>
    </aside>
  );
}
