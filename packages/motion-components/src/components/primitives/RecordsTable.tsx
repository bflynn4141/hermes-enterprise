// Adapted from Beautiful UI — Copyright (c) 2026 Shane Levine, MIT. See LICENSE.beautiful-ui.
"use client";
// SPDX-License-Identifier: MIT — adapted from Beautiful UI; see LICENSE.beautiful-ui.
import { useReducedMotion } from "../../lib/motion";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import GlideMenu from "./GlideMenu";

/* ─────────────────────────────────────────────────────────
 * RECORDS TABLE — an AI spreadsheet grid. Columns are
 * *properties*: click a header to open its configuration
 * popover (type, tool, grounding, inputs, prompt, run), add
 * a new AI property from the + header, and watch cells
 * resolve row-by-row while it calculates.
 * ───────────────────────────────────────────────────────── */

export type Strength = "strong" | "weak" | "veryweak" | "none";
type SortKey = "name" | "last" | "strength";
type ColumnKey = "company" | "categories" | "last" | "strength" | "links" | "ai";

const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
  company: 270,
  categories: 275,
  last: 190,
  strength: 210,
  links: 175,
  ai: 240,
};

const STRENGTH: Record<Strength, { label: string; color: string; rank: number }> = {
  strong: { label: "Sources checked", color: "var(--green)", rank: 3 },
  weak: { label: "Gaps open", color: "var(--orange)", rank: 2 },
  veryweak: { label: "Sources missing", color: "var(--red)", rank: 1 },
  none: { label: "Not assessed", color: "var(--ink-3)", rank: 0 },
};

// A single mid-lightness base hue per tag. Background, text, and border are
// derived from this via color-mix() against the theme tokens in .records-tag,
// so the chips adapt to light and dark automatically (same pattern as FilterTable).
type TagColor = { base: string };

const TAG_PALETTE: Record<string, TagColor> = {
  amber: { base: "oklch(0.76 0.13 70)" },
  lime: { base: "oklch(0.77 0.16 122)" },
  yellow: { base: "oklch(0.80 0.15 101)" },
  purple: { base: "oklch(0.62 0.18 293)" },
  orange: { base: "oklch(0.71 0.16 48)" },
  cyan: { base: "oklch(0.72 0.10 221)" },
  red: { base: "oklch(0.64 0.19 27)" },
  magenta: { base: "oklch(0.66 0.21 323)" },
  green: { base: "oklch(0.70 0.13 162)" },
  pink: { base: "oklch(0.67 0.19 3)" },
};

const TAG_COLORS: Record<string, TagColor> = {
  Applicant: TAG_PALETTE.cyan, Technical: TAG_PALETTE.purple,
  Provider: TAG_PALETTE.amber, Onboarding: TAG_PALETTE.green,
  "Needs review": TAG_PALETTE.orange, "Needs context": TAG_PALETTE.yellow,
};

export type RecordRow = {
  id: string;
  name: string;
  tags: string[];
  last: string;
  strength: Strength;
  website?: string;
  reviewGap?: string;
};

export const PARTNER_RECORDS: RecordRow[] = [
  { id: "leah", name: "Leah", tags: ["Applicant", "Technical", "Needs review"], last: "2026-10-12", strength: "weak", reviewGap: "Customer impact unverified; timeline missing" },
  { id: "owen", name: "Owen Brooks", tags: ["Applicant", "Technical", "Needs review"], last: "2026-10-12", strength: "weak", reviewGap: "Customer impact unverified; capacity unconfirmed" },
  { id: "robin", name: "Robin Ellis", tags: ["Provider", "Needs review"], last: "2026-10-09", strength: "strong", reviewGap: "Delivery and consent cited; documents await Maya" },
  { id: "noor", name: "Noor", tags: ["Onboarding", "Needs context"], last: "2026-10-12", strength: "veryweak", reviewGap: "Feedback destination missing" },
];
const AI_LABEL = "Review gaps";
export type CalculationRequest = { column: string; rows: RecordRow[]; prompt: string; inputs: string[]; model: string; grounding: boolean; type: string; required: boolean; allowEmpty: boolean; showSourceCoverage: boolean };

function Icon({ children, size = 14, strokeWidth = 1.8 }: { children: React.ReactNode; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/* glyph library for property types & tools */
const TYPE_GLYPHS: Record<string, React.ReactNode> = {
  Text: <path d="M4 6h16M4 12h10M4 18h7" />,
  File: <g><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></g>,
  Collection: <g><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></g>,
  "Single select": <g><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.4 2.4 4.6-4.9" /></g>,
  "Multi select": <g><path d="M11 6h9M11 12h9M11 18h9" /><path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17" /></g>,
  URL: <g><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></g>,
  Reference: <path d="M7 17 17 7M9 7h8v8" />,
  JSON: <g><path d="M8 4c-2 0-2 2-2 3s.5 3-2 3c2.5 0 2 2 2 3s0 3 2 3" /><path d="M16 4c2 0 2 2 2 3s-.5 3 2 3c-2.5 0-2 2-2 3s0 3-2 3" /></g>,
  "File splitter": <g><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></g>,
  Date: <g><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M8 3v4M16 3v4M3 10h18" /></g>,
};

const TOOL_GLYPHS: Record<string, React.ReactNode> = {
  model: <path d="M12 3l1.7 5.1a2 2 0 0 0 1.2 1.2L20 11l-5.1 1.7a2 2 0 0 0-1.2 1.2L12 19l-1.7-5.1a2 2 0 0 0-1.2-1.2L4 11l5.1-1.7a2 2 0 0 0 1.2-1.2z" />,
  web: <g><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a13.5 13.5 0 0 1 3.5 9 13.5 13.5 0 0 1-3.5 9 13.5 13.5 0 0 1-3.5-9A13.5 13.5 0 0 1 12 3z" /></g>,
  user: <g><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></g>,
};

/* per-property configuration shown in the popover */
type Prompt = { before: string; chip?: string; after?: string };
type ToolKind = "model" | "web" | "user";
type ColumnMeta = { type: string; tool: string; toolKind: ToolKind; inputs?: string; prompt?: Prompt };

const COLUMN_META: Record<string, ColumnMeta> = {
  Record: { type: "Text", tool: "User input", toolKind: "user" },
  Type: { type: "Multi select", tool: "DeepSeek 4.1 Flash", toolKind: "model", inputs: "Record", prompt: { before: "Tag each ", chip: "Record", after: " with its program role." } },
  "Last updated": { type: "Date", tool: "User input", toolKind: "user" },
  "Evidence coverage": { type: "Single select", tool: "DeepSeek 4.1 Flash", toolKind: "model", inputs: "Record", prompt: { before: "Inspect cited evidence from ", chip: "Record", after: "." } },
  Links: { type: "URL", tool: "Web search", toolKind: "web", inputs: "Record", prompt: { before: "Find the website for ", chip: "Record", after: "." } },
  [AI_LABEL]: { type: "Text", tool: "DeepSeek 4.1 Flash", toolKind: "model", inputs: "Record", prompt: { before: "Find cited gaps for ", chip: "Record" } },
};

const NEW_PROPERTY_TYPES = ["Text", "File", "Collection", "Single select", "Multi select", "URL", "Reference", "JSON", "File splitter"];
const MODEL_OPTIONS = ["DeepSeek 4.1 Flash", "Opus 4.7", "GPT-5.5"];
const INPUT_OPTIONS = ["Record", "Type", "Last updated", "Evidence coverage", "Links"];

function Checkbox({ checked, mixed = false, onChange, label }: { checked: boolean; mixed?: boolean; onChange: () => void; label: string }) {
  return (
    <label className="records-checkbox" title={label} onClick={(event) => event.stopPropagation()}>
      <input type="checkbox" checked={checked} onChange={onChange} aria-label={label} />
      <span className={`records-checkbox-box ${checked || mixed ? "is-active" : ""}`}>
        {mixed ? <span className="records-checkbox-dash" /> : checked ? <Icon size={12}><path d="m5 12 4 4L19 6" /></Icon> : null}
      </span>
    </label>
  );
}

function Tag({ name }: { name: string }) {
  const color = TAG_COLORS[name] ?? { base: "var(--ink-3)" };
  return (
    <span
      className="records-tag"
      style={{ "--tag-base": color.base } as React.CSSProperties}
    >
      {name}
    </span>
  );
}

function TagList({ tags }: { tags: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tags.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const update = () => {
      const available = container.clientWidth;
      const tagWidths = Array.from(measure.querySelectorAll<HTMLElement>("[data-tag-measure]"), (tag) => tag.offsetWidth);
      const moreWidth = measure.querySelector<HTMLElement>("[data-more-measure]")?.offsetWidth ?? 0;
      let used = 0;
      let count = 0;

      for (let index = 0; index < tagWidths.length; index += 1) {
        const nextUsed = used + (count > 0 ? 4 : 0) + tagWidths[index];
        const hiddenAfter = tags.length - (index + 1);
        const totalWithOverflow = nextUsed + (hiddenAfter > 0 ? 4 + moreWidth : 0);
        if (totalWithOverflow > available) break;
        used = nextUsed;
        count += 1;
      }

      setVisibleCount(count);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [tags]);

  const hiddenCount = tags.length - visibleCount;

  return (
    <div ref={containerRef} className="records-tags" title={tags.join(", ")} aria-label={`Type: ${tags.join(", ")}`}>
      <div ref={measureRef} className="records-tags-measure" aria-hidden>
        {tags.map((tag) => <span key={tag} data-tag-measure><Tag name={tag} /></span>)}
        <span data-more-measure className="records-more-tag">+{tags.length}</span>
      </div>
      {tags.slice(0, visibleCount).map((tag) => <Tag key={tag} name={tag} />)}
      {hiddenCount > 0 && <span className="records-more-tag">+{hiddenCount}</span>}
    </div>
  );
}

function CalcCell() {
  return (
    <span className="records-calc">
      <span className="records-muted">Calculating…</span>
      <span className="records-pulse" />
    </span>
  );
}

function MiniSwitch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className="relative h-4.5 w-7.5 shrink-0 rounded-full transition-colors duration-150"
      style={{ background: on ? "var(--accent)" : "var(--line-strong)" }}
    >
      <span
        className="absolute top-0.5 left-0.5 size-3.5 rounded-full bg-white shadow-btn transition-transform duration-150"
        style={{ transform: on ? "translateX(12px)" : "translateX(0)", transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)" }}
      />
    </button>
  );
}

function HeaderCell({ label, icon, sortKey, sort, onSort, onResizeStart, resizing = false, className = "", selected = false, onPick }: { label: string; icon: React.ReactNode; sortKey?: SortKey; sort: { key: SortKey; dir: 1 | -1 }; onSort: (key: SortKey) => void; onResizeStart: (event: React.PointerEvent<HTMLSpanElement>) => void; resizing?: boolean; className?: string; selected?: boolean; onPick?: (event: React.MouseEvent) => void }) {
  return (
    <th className={`records-header-cell ${selected ? "is-colsel" : ""} ${className}`}>
      {/* header click opens the property config; the arrow sorts */}
      <div className="records-header-button">
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
          onClick={onPick}
        >
          <span className="records-header-icon">{icon}</span>
          <span className="truncate">{label}</span>
        </button>
        {sortKey && (
          <button
            type="button"
            aria-label={`Sort by ${label}`}
            onClick={(event) => {
              event.stopPropagation();
              onSort(sortKey);
            }}
            className={`records-sort focus-visible:opacity-100 ${sort.key === sortKey ? "is-visible" : ""}`}
            style={{ transform: sort.key === sortKey && sort.dir === -1 ? "rotate(180deg)" : undefined }}
          >
            <Icon size={12}><path d="M12 5v14M5 12l7 7 7-7" /></Icon>
          </button>
        )}
      </div>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} column`}
        className={`records-resize-handle ${resizing ? "is-resizing" : ""}`}
        onPointerDown={onResizeStart}
      />
    </th>
  );
}

/* config row inside the property popover */
function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative flex h-8 items-center justify-between">
      <span className="text-[13px] text-ink-3">{label}</span>
      {children}
    </div>
  );
}

function menuBounds(x: number, y: number, preferredWidth: number, preferredHeight: number): React.CSSProperties {
  const width = Math.min(preferredWidth, window.innerWidth - 24);
  const top = Math.max(12, Math.min(y, window.innerHeight - preferredHeight - 12));
  return { left: Math.max(12, Math.min(x, window.innerWidth - width - 12)), top, width,
    maxHeight: Math.max(80, window.innerHeight - top - 12), overflowY: "auto", overscrollBehavior: "contain" };
}

/** Portals keep nested pickers outside the parent panel's scroll clipping. */
function MenuSurface({ label, width, height, children }: { label: string; width: number; height: number; children: React.ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const [placement, setPlacement] = useState<React.CSSProperties | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const rect = anchor.current?.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const x = rect.right + width + 18 <= window.innerWidth ? rect.right + 6
        : rect.left - width - 6 >= 12 ? rect.left - width - 6 : window.innerWidth - width - 12;
      setPlacement(menuBounds(x, rect.top, width, height));
    };
    measure(); window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [width, height]);
  return <><span ref={anchor} aria-hidden className="pointer-events-none absolute size-0" />{placement && createPortal(
    <div data-recpop data-reduced-motion={reduce} role="menu" aria-label={label}
      className="hermes-ui fixed z-[70] rounded-[12px] bg-surface p-1.5 shadow-overlay"
      style={{ ...placement, animation: reduce ? "none" : "pop-in 140ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" }}>
      {children}
    </div>, document.body)}</>;
}

function ConfigPicker({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: { label: string; icon: React.ReactNode }[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <MenuSurface label={label} width={210} height={options.length * 33 + 36}>
      <div className="px-2 pb-1 pt-0.5 text-[11.5px] font-medium text-ink-3">{label}</div>
      <GlideMenu className="flex flex-col gap-px">
        {options.map((option) => (
          <button
            key={option.label}
            data-menu-row
            type="button"
            role="menuitemradio"
            aria-checked={selected === option.label}
            onClick={() => onSelect(option.label)}
            className="relative z-10 flex h-8 w-full items-center gap-1.5 rounded-[8px] px-1.5 text-left text-[13px] font-medium text-ink"
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-ink-2">{option.icon}</span>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <span className={selected === option.label ? "text-ink" : "invisible"}>
              <Icon size={14} strokeWidth={2.2}><path d="m5 12 4 4L19 6" /></Icon>
            </span>
          </button>
        ))}
      </GlideMenu>
    </MenuSurface>
  );
}

function InputPicker({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <MenuSurface label="Calculation inputs" width={220} height={options.length * 33 + 36}>
      <div className="px-2 pb-1 pt-0.5 text-[11.5px] font-medium text-ink-3">Use values from</div>
      <GlideMenu className="flex flex-col gap-px">
        {options.map((option) => {
          const checked = selected.includes(option);
          return (
            <button
              key={option}
              data-menu-row
              type="button"
              role="menuitemcheckbox"
              aria-checked={checked}
              onClick={() => onToggle(option)}
              className="relative z-10 flex h-8 w-full items-center gap-1.5 rounded-[8px] px-1.5 text-left text-[13px] font-medium text-ink"
            >
              <span className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] border ${checked ? "border-accent bg-accent text-white" : "border-line-strong text-transparent"}`}>
                <Icon size={11} strokeWidth={2.4}><path d="m5 12 4 4L19 6" /></Icon>
              </span>
              <span className="min-w-0 flex-1 truncate">{option}</span>
            </button>
          );
        })}
      </GlideMenu>
    </MenuSurface>
  );
}

export default function RecordsTable({ rows = PARTNER_RECORDS, fill = false, onSelectionChange, onOpenRow, onCalculate }: { rows?: RecordRow[]; fill?: boolean; variant?: string; onSelectionChange?: (ids: string[]) => void; onOpenRow?: (row: RecordRow) => void; onCalculate?: (request: CalculationRequest) => Promise<Record<string, string>> } = {}) {
  const reduce = useReducedMotion();
  const requestId = useRef(0);
  const [calculating, setCalculating] = useState(false);
  const [calculationError, setCalculationError] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const promptRef = useRef<HTMLDivElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => { requestId.current++; resizeCleanup.current?.(); }, []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [columnWidths, setColumnWidths] = useState(DEFAULT_COLUMN_WIDTHS);
  const [actionColumnWidth, setActionColumnWidth] = useState(100);
  const [columnWidthsLocked, setColumnWidthsLocked] = useState(false);
  const [resizingColumn, setResizingColumn] = useState<ColumnKey | null>(null);
  const initialColumnWidthsRef = useRef<Record<ColumnKey, number> | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  /* property popover, anchored to the clicked header */
  const [prop, setProp] = useState<{ col: string; x: number; y: number } | null>(null);
  const [grounding, setGrounding] = useState(true);
  const [groundingHelpOpen, setGroundingHelpOpen] = useState(false);
  const [configMenu, setConfigMenu] = useState<"type" | "tool" | "inputs" | null>(null);
  const [columnOverrides, setColumnOverrides] = useState<Record<string, Partial<ColumnMeta>>>({});
  const [inputSelections, setInputSelections] = useState<Record<string, string[]>>({});
  const [pinnedColumns, setPinnedColumns] = useState<Set<string>>(() => new Set(typeof window !== "undefined" && window.innerWidth < 640 ? [] : ["Record"]));
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const adapt = () => { if (media.matches) setPinnedColumns(new Set()); };
    adapt(); media.addEventListener("change", adapt);
    return () => media.removeEventListener("change", adapt);
  }, []);
  const [moreSettingsOpen, setMoreSettingsOpen] = useState(false);
  const [advancedSettings, setAdvancedSettings] = useState({ required: false, allowEmpty: true, confidence: false });
  /* + new-property menu */
  const [addOpen, setAddOpen] = useState<{ x: number; y: number } | null>(null);
  const [tableMenuOpen, setTableMenuOpen] = useState<{ x: number; y: number } | null>(null);
  /* the added AI column and its lifecycle */
  const [aiAdded, setAiAdded] = useState(false);
  const [aiDone, setAiDone] = useState(false);
  const [pendingOpenAi, setPendingOpenAi] = useState(false);
  const aiThRef = useRef<HTMLTableCellElement>(null);
  /* programmatic scrolls (revealing the new column) shouldn't close popovers */
  const ignoreScrollRef = useRef(false);
  /* a running calculation resolves rows one by one */
  const [calc, setCalc] = useState<{ col: string; resolved: number } | null>(null);

  /* Let the table fill its available space once, then capture those rendered
   * widths before paint. From that point on every column is explicit, so a
   * resize changes only the dragged column and the table's total width. */
  useLayoutEffect(() => {
    if (columnWidthsLocked || !tableRef.current) return;
    const headers = Array.from(tableRef.current.querySelectorAll<HTMLTableCellElement>("thead th"));
    if (headers.length < 6) return;

    const measured: Record<ColumnKey, number> = {
      company: headers[0].getBoundingClientRect().width,
      categories: headers[1].getBoundingClientRect().width,
      last: headers[2].getBoundingClientRect().width,
      strength: headers[3].getBoundingClientRect().width,
      links: headers[4].getBoundingClientRect().width,
      ai: DEFAULT_COLUMN_WIDTHS.ai,
    };
    initialColumnWidthsRef.current = measured;
    setColumnWidths(measured);
    setActionColumnWidth(headers[headers.length - 1].getBoundingClientRect().width);
    setColumnWidthsLocked(true);
  }, [columnWidthsLocked]);

  useLayoutEffect(() => {
    if (!tableRef.current) return;
    const columns: { label: string; width: number }[] = [
      { label: "Record", width: columnWidths.company }, { label: "Type", width: columnWidths.categories },
      { label: "Last updated", width: columnWidths.last }, { label: "Evidence coverage", width: columnWidths.strength },
      { label: "Links", width: columnWidths.links }, ...(aiAdded ? [{ label: AI_LABEL, width: columnWidths.ai }] : []),
    ];
    let left = 0;
    columns.forEach((column, index) => {
      const pinned = pinnedColumns.has(column.label);
      tableRef.current!.querySelectorAll<HTMLTableCellElement>(`tr > :nth-child(${index + 1})`).forEach(cell => {
        cell.style.position = pinned || cell.tagName === "TH" ? "sticky" : "static";
        cell.style.left = pinned ? `${left}px` : "auto";
        cell.style.zIndex = pinned ? (cell.tagName === "TH" ? "14" : "3") : "";
        cell.style.backgroundColor = pinned ? (cell.parentElement?.classList.contains("is-selected") ? "var(--hover)" : "var(--surface)") : "";
      });
      if (pinned) left += column.width;
    });
  }, [pinnedColumns, aiAdded, columnWidths, selected]);

  const visibleRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const value = sort.key === "name"
        ? a.name.localeCompare(b.name)
        : sort.key === "last"
          ? a.last.localeCompare(b.last)
          : STRENGTH[a.strength].rank - STRENGTH[b.strength].rank;
      return value * sort.dir;
    });
  }, [rows, sort]);

  /* stagger: one row resolves every beat */
  useEffect(() => {
    if (!calc) return;
    if (reduce) { if (calc.col === AI_LABEL) setAiDone(true); setCalc(null); return; }
    if (calc.resolved > visibleRows.length) {
      if (calc.col === AI_LABEL) setAiDone(true);
      setCalc(null);
      return;
    }
    const t = setTimeout(() => setCalc((current) => (current ? { ...current, resolved: current.resolved + 1 } : current)), 110);
    return () => clearTimeout(t);
  }, [calc, visibleRows.length, reduce]);

  /* after adding the AI column, scroll it into view and open its config
   * anchored to the new header */
  useEffect(() => {
    if (!pendingOpenAi || !aiThRef.current) return;
    const scroller = aiThRef.current.closest(".records-scroll");
    if (scroller) {
      ignoreScrollRef.current = true;
      scroller.scrollLeft = scroller.scrollWidth;
    }
    const rect = aiThRef.current.getBoundingClientRect();
    setProp({ col: AI_LABEL, x: Math.min(rect.left, window.innerWidth - 336), y: rect.bottom + 6 });
    setPendingOpenAi(false);
  }, [pendingOpenAi, aiAdded]);

  /* click anywhere else closes popovers */
  useEffect(() => {
    if (!prop && !addOpen && !tableMenuOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setProp(null); setAddOpen(null); setTableMenuOpen(null); setConfigMenu(null); } };
    document.addEventListener("keydown", escape);
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-recpop]")) {
        setProp(null);
        setConfigMenu(null);
        setGroundingHelpOpen(false);
        setMoreSettingsOpen(false);
        setAddOpen(null);
        setTableMenuOpen(null);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [prop, addOpen, tableMenuOpen]);

  const openProp = (col: string) => (event: React.MouseEvent) => {
    const th = (event.currentTarget as Element).closest("th");
    if (!th) return;
    setAddOpen(null);
    setTableMenuOpen(null);
    setConfigMenu(null);
    setGroundingHelpOpen(false);
    setMoreSettingsOpen(false);
    setProp((current) => {
      if (current?.col === col) return null;
      const rect = th.getBoundingClientRect();
      return { col, x: Math.min(rect.left, window.innerWidth - 336), y: rect.bottom + 6 };
    });
  };

  const isCalc = (col: string, index: number) => !!calc && calc.col === col && index >= calc.resolved;

  const allSelected = visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.id));
  const partiallySelected = !allSelected && visibleRows.some((row) => selected.has(row.id));

  const toggleSort = (key: SortKey) => setSort((current) => current.key === key ? { key, dir: (current.dir * -1) as 1 | -1 } : { key, dir: 1 });
  const startColumnResize = (key: ColumnKey, minWidth = 120) => (event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setProp(null);
    setConfigMenu(null);
    setGroundingHelpOpen(false);
    setMoreSettingsOpen(false);
    setAddOpen(null);
    setTableMenuOpen(null);

    resizeCleanup.current?.();
    const startX = event.clientX;
    const startWidth = columnWidths[key];
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizingColumn(key);

    const move = (moveEvent: PointerEvent) => {
      const width = Math.max(minWidth, startWidth + moveEvent.clientX - startX);
      setColumnWidths((current) => ({ ...current, [key]: width }));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      setResizingColumn(null);
      resizeCleanup.current = null;
    };

    resizeCleanup.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const toggleRow = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next); onSelectionChange?.([...next]);
  };
  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) visibleRows.forEach((row) => next.delete(row.id));
    else visibleRows.forEach((row) => next.add(row.id));
    setSelected(next); onSelectionChange?.([...next]);
  };

  const meta = prop ? { ...COLUMN_META[prop.col], ...columnOverrides[prop.col] } : null;
  const selectedInputs = prop && meta
    ? inputSelections[prop.col] ?? (meta.inputs ? [meta.inputs] : [])
    : [];
  const tableWidth = columnWidths.company + columnWidths.categories + columnWidths.last + columnWidths.strength + columnWidths.links + (aiAdded ? columnWidths.ai : 0) + actionColumnWidth;

  return (
    <div data-reduced-motion={reduce} className={`hermes-ui records-shell${fill ? " is-fill" : ""}`}>
      <div
        className="records-scroll"
        tabIndex={0}
        aria-label="Program records table. Scroll horizontally and vertically to view all columns and records."
        onScroll={() => {
          if (ignoreScrollRef.current) {
            ignoreScrollRef.current = false;
            return;
          }
          setProp(null);
          setConfigMenu(null);
          setGroundingHelpOpen(false);
          setMoreSettingsOpen(false);
          setAddOpen(null);
          setTableMenuOpen(null);
        }}
      >
        <table ref={tableRef} className="records-table" style={{ width: columnWidthsLocked ? tableWidth : "100%", minWidth: tableWidth }}>
          <colgroup>
            <col className="records-company-col" style={{ width: columnWidths.company }} />
            <col className="records-category-col" style={{ width: columnWidths.categories }} />
            <col className="records-last-col" style={{ width: columnWidths.last }} />
            <col className="records-strength-col" style={{ width: columnWidths.strength }} />
            <col className="records-link-col" style={{ width: columnWidths.links }} />
            {aiAdded && <col style={{ width: columnWidths.ai }} />}
            <col style={{ width: 100 }} />
          </colgroup>
          <thead>
            <tr>
              <th className={`records-header-cell records-sticky-cell ${prop?.col === "Record" ? "is-colsel" : ""}`}>
                <div className="records-company-header" style={{ cursor: "pointer" }} onClick={(event) => openProp("Record")(event)}>
                  <Checkbox checked={allSelected} mixed={partiallySelected} onChange={toggleAll} label="Select all records" />
                  <span>Record</span>
                  <button type="button" aria-label="Sort records by name" onClick={event => { event.stopPropagation(); toggleSort("name"); }} className="ml-auto text-ink-3"><Icon size={12}><path d="M12 5v14M5 12l7 7 7-7" /></Icon></button>
                </div>
                <span role="separator" aria-orientation="vertical" aria-label="Resize Record column" className={`records-resize-handle ${resizingColumn === "company" ? "is-resizing" : ""}`} onPointerDown={startColumnResize("company", 180)} />
              </th>
              <HeaderCell label="Type" selected={prop?.col === "Type"} onPick={openProp("Type")} sort={sort} onSort={toggleSort} onResizeStart={startColumnResize("categories")} resizing={resizingColumn === "categories"} icon={<Icon size={15}>{TYPE_GLYPHS["Multi select"]}</Icon>} />
              <HeaderCell label="Last updated" selected={prop?.col === "Last updated"} onPick={openProp("Last updated")} sortKey="last" sort={sort} onSort={toggleSort} onResizeStart={startColumnResize("last")} resizing={resizingColumn === "last"} icon={<Icon size={15}>{TYPE_GLYPHS.Date}</Icon>} />
              <HeaderCell label="Evidence coverage" selected={prop?.col === "Evidence coverage"} onPick={openProp("Evidence coverage")} sortKey="strength" sort={sort} onSort={toggleSort} onResizeStart={startColumnResize("strength")} resizing={resizingColumn === "strength"} icon={<Icon size={15}>{TYPE_GLYPHS["Single select"]}</Icon>} />
              <HeaderCell label="Links" selected={prop?.col === "Links"} onPick={openProp("Links")} sort={sort} onSort={toggleSort} onResizeStart={startColumnResize("links")} resizing={resizingColumn === "links"} icon={<Icon size={15}>{TYPE_GLYPHS.URL}</Icon>} />
              {aiAdded && (
                <th ref={aiThRef} className={`records-header-cell ${prop?.col === AI_LABEL ? "is-colsel" : ""}`}>
                  <button type="button" className="records-header-button" onClick={openProp(AI_LABEL)}>
                    <span className="records-header-icon"><Icon size={15}>{TYPE_GLYPHS.Text}</Icon></span>
                    <span className="truncate">{AI_LABEL}</span>
                  </button>
                  <span role="separator" aria-orientation="vertical" aria-label={`Resize ${AI_LABEL} column`} className={`records-resize-handle ${resizingColumn === "ai" ? "is-resizing" : ""}`} onPointerDown={startColumnResize("ai")} />
                </th>
              )}
              <th className="records-header-cell">
                <div className="flex h-[35px] items-center gap-1 px-2">
                  <button
                    type="button"
                    aria-label="New property"
                    data-recpop
                    onClick={(event) => {
                      setProp(null);
                      setTableMenuOpen(null);
                      const rect = (event.currentTarget as Element).getBoundingClientRect();
                      setAddOpen((current) => (current ? null : { x: Math.min(rect.left, window.innerWidth - 276), y: rect.bottom + 6 }));
                    }}
                    className="flex size-7 items-center justify-center rounded-[7px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
                  >
                    <Icon size={15} strokeWidth={2}><path d="M12 5v14M5 12h14" /></Icon>
                  </button>
                  <button
                    type="button"
                    aria-label="Table options"
                    aria-expanded={!!tableMenuOpen}
                    data-recpop
                    onClick={(event) => {
                      setProp(null);
                      setAddOpen(null);
                      const rect = event.currentTarget.getBoundingClientRect();
                      setTableMenuOpen((current) => current ? null : {
                        x: Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228)),
                        y: rect.bottom + 6,
                      });
                    }}
                    className="flex size-7 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
                  </button>
                </div>
              </th>
            </tr>
          </thead>
          {/* data cells stay silent — the papery link/flick sound is too much when scanning rows */}
          <tbody data-sound-silent>
            {visibleRows.map((row, index) => {
              const selectedRow = selected.has(row.id);
              const strength = STRENGTH[row.strength];
              return <tr key={row.id} className={`records-row ${selectedRow ? "is-selected" : ""}`}>
                <td className={`records-cell records-sticky-cell records-company-cell ${prop?.col === "Record" ? "is-colsel" : ""}`}><span className="records-rownum">{index + 1}</span><Checkbox checked={selectedRow} onChange={() => toggleRow(row.id)} label={`Select ${row.name}`} /><span className="records-company-mark">{row.name.slice(0, 1).toUpperCase()}</span><button type="button" disabled={!onOpenRow} onClick={() => onOpenRow?.(row)} title={row.name} className="records-company-name">{row.name}</button></td>
                <td className={`records-cell ${prop?.col === "Type" ? "is-colsel" : ""}`}>{isCalc("Type", index) ? <CalcCell /> : <TagList tags={row.tags} />}</td>
                <td className={`records-cell ${row.last === "No contact" ? "records-muted" : ""} ${prop?.col === "Last updated" ? "is-colsel" : ""}`}>{isCalc("Last updated", index) ? <CalcCell /> : row.last}</td>
                <td className={`records-cell ${prop?.col === "Evidence coverage" ? "is-colsel" : ""}`}>{isCalc("Evidence coverage", index) ? <CalcCell /> : <span className="records-strength"><span className="records-strength-dot" style={{ background: strength.color }} />{strength.label}</span>}</td>
                <td className={`records-cell ${prop?.col === "Links" ? "is-colsel" : ""}`}>{isCalc("Links", index) ? <CalcCell /> : row.website ? <a className="records-link" href={`https://${row.website}`} title={row.website} target="_blank" rel="noreferrer"><span className="records-link-label">{row.website}</span><Icon size={12}><path d="M14 5h5v5M19 5l-8 8" /></Icon></a> : <span className="records-muted">—</span>}</td>
                {aiAdded && (
                  <td className={`records-cell ${prop?.col === AI_LABEL ? "is-colsel" : ""}`}>
                    {calc?.col === AI_LABEL ? (index < calc.resolved ? (values[row.id] ?? row.reviewGap ?? "Not assessed") : <CalcCell />) : aiDone ? (values[row.id] ?? row.reviewGap ?? "Not assessed") : <span className="records-muted">—</span>}
                  </td>
                )}
                <td className="records-cell" />
              </tr>;
            })}
          </tbody>
          <tfoot>
            <tr className="records-calculation-row">
              <td className="records-cell records-sticky-cell">
                <span className="records-footer-value records-calculation-label"><span className="records-calculation-number">{rows.length}</span> count</span>
              </td>
              <td className="records-cell">
                <button type="button" className="records-add-calculation" onClick={(event) => { setAiAdded(true); setPendingOpenAi(true); setColumnOverrides(current => ({ ...current, [AI_LABEL]: { type: "Text" } })); event.stopPropagation(); }}><Icon size={15}><path d="M12 5v14M5 12h14" /></Icon>Add calculation</button>
              </td>
              <td className="records-cell records-muted"><span className="records-footer-value">—</span></td>
              <td className="records-cell">
                <span className="records-footer-value records-average"><span className="records-strength-dot" style={{ background: "var(--orange)" }} />{rows.filter(row => row.strength === "strong").length} {rows.filter(row => row.strength === "strong").length === 1 ? "source" : "sources"} checked</span>
              </td>
              <td className="records-cell"><span className="records-footer-value records-muted">{rows.filter((row) => row.website).length} links</span></td>
              {aiAdded && <td className="records-cell records-muted"><span className="records-footer-value">{aiDone ? `${rows.length} filled` : "—"}</span></td>}
              <td className="records-cell" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── property configuration popover ─────────────────── */}
      {prop && meta && (
        <div
          data-recpop
          className="fixed z-50 w-[320px] rounded-[14px] bg-surface px-3 pt-3 pb-1.5 shadow-overlay"
          style={{ ...menuBounds(prop.x, prop.y, 320, moreSettingsOpen ? 580 : 440), animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" }}
        >
          <div className="pb-2 text-[13.5px] font-medium text-ink">{prop.col}</div>

          <ConfigRow label="Type">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={configMenu === "type"}
              onClick={() => setConfigMenu((current) => current === "type" ? null : "type")}
              className="flex items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[13px] font-medium text-ink transition-colors duration-100 hover:bg-hover"
            >
              <span className="text-ink-2"><Icon size={14}>{TYPE_GLYPHS[meta.type] ?? TYPE_GLYPHS.Text}</Icon></span>
              {meta.type}
              <span className="text-ink-3"><Icon size={12} strokeWidth={2.2}><path d="M9 6l6 6-6 6" /></Icon></span>
            </button>
            {configMenu === "type" && (
              <ConfigPicker
                label="Property type"
                selected={meta.type}
                options={NEW_PROPERTY_TYPES.map((type) => ({ label: type, icon: <Icon size={15}>{TYPE_GLYPHS[type]}</Icon> }))}
                onSelect={(type) => {
                  setColumnOverrides((current) => ({ ...current, [prop.col]: { ...current[prop.col], type } }));
                  setConfigMenu(null);
                }}
              />
            )}
          </ConfigRow>
          <ConfigRow label="Tool">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={configMenu === "tool"}
              onClick={() => setConfigMenu((current) => current === "tool" ? null : "tool")}
              className="flex items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[13px] font-medium text-ink transition-colors duration-100 hover:bg-hover"
            >
              <span className={meta.toolKind === "model" ? "text-accent" : "text-ink-2"}>
                {meta.toolKind === "model"
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>{TOOL_GLYPHS.model}</svg>
                  : <Icon size={14}>{TOOL_GLYPHS[meta.toolKind]}</Icon>}
              </span>
              {meta.tool}
              <span className="text-ink-3"><Icon size={12} strokeWidth={2.2}><path d="M9 6l6 6-6 6" /></Icon></span>
            </button>
            {configMenu === "tool" && (
              <ConfigPicker
                label="Model"
                selected={meta.tool}
                options={MODEL_OPTIONS.map((model) => ({
                  label: model,
                  icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>{TOOL_GLYPHS.model}</svg>,
                }))}
                onSelect={(tool) => {
                  setColumnOverrides((current) => ({ ...current, [prop.col]: { ...current[prop.col], tool, toolKind: "model" } }));
                  setConfigMenu(null);
                }}
              />
            )}
          </ConfigRow>
          <ConfigRow label="Grounding">
            <span className="flex items-center gap-2">
              <MiniSwitch label="Grounding" on={grounding} onToggle={() => setGrounding((current) => !current)} />
              <button
                type="button"
                aria-label="About grounding"
                aria-expanded={groundingHelpOpen}
                onClick={() => setGroundingHelpOpen((open) => !open)}
                className="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
              >
                <Icon size={13}><g><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></g></Icon>
              </button>
            </span>
            {groundingHelpOpen && (
              <div className="absolute right-0 top-[30px] z-30 w-[230px] rounded-[10px] px-3 py-2.5 text-[12px] leading-relaxed shadow-overlay" style={{ color: "var(--tooltip-fg)", background: "var(--tooltip-bg)" }} role="status">
                Grounding requests citations from selected sources. It does not prove a claim is true.
              </div>
            )}
          </ConfigRow>
          <ConfigRow label="Inputs">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={configMenu === "inputs"}
              onClick={() => setConfigMenu((current) => current === "inputs" ? null : "inputs")}
              className="flex max-w-[220px] items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[13px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
            >
              {selectedInputs.length ? (
                <span className="flex min-w-0 items-center gap-1">
                  {selectedInputs.slice(0, 2).map((input) => (
                    <span key={input} className="max-w-[92px] truncate rounded-[5px] bg-accent-tint px-1.5 py-0.5 text-[12px] font-medium text-accent-ink">{input}</span>
                  ))}
                  {selectedInputs.length > 2 && <span className="text-[11px] font-medium text-ink-3">+{selectedInputs.length - 2}</span>}
                </span>
              ) : (
                <span>Select inputs</span>
              )}
              <span className="shrink-0 text-ink-3"><Icon size={12} strokeWidth={2.2}><path d="M9 6l6 6-6 6" /></Icon></span>
            </button>
            {configMenu === "inputs" && (
              <InputPicker
                selected={selectedInputs}
                options={INPUT_OPTIONS.filter((input) => input !== prop.col)}
                onToggle={(input) => {
                  setInputSelections((current) => {
                    const existing = current[prop.col] ?? (meta.inputs ? [meta.inputs] : []);
                    const next = existing.includes(input) ? existing.filter((item) => item !== input) : [...existing, input];
                    return { ...current, [prop.col]: next };
                  });
                }}
              />
            )}
          </ConfigRow>

          {/* prompt — @-mention chips inline */}
          <div
            ref={promptRef}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-label={`${prop.col} calculation prompt`}
            aria-multiline="true"
            spellCheck
            className="mt-2 min-h-[88px] cursor-text rounded-[10px] bg-inset p-3 text-[13px] leading-relaxed shadow-hairline outline-none transition-[box-shadow] duration-150 focus:shadow-[0_0_0_2px_var(--accent)]"
          >
            {meta.prompt ? (
              <span className="text-ink">
                {meta.prompt.before}
                {meta.prompt.chip && <span contentEditable={false} className="rounded-[5px] bg-accent-tint px-1.5 py-0.5 text-[12px] font-medium text-accent-ink">{meta.prompt.chip}</span>}
                {meta.prompt.after}
              </span>
            ) : (
              <span className="text-ink-3">Set a prompt (press @ to mention an input)</span>
            )}
          </div>

          <button
            type="button"
            disabled={!!calc || calculating}
            onClick={async () => {
              if (calculating || calc) return;
              const id = ++requestId.current;
              const column = prop.col;
              setCalculating(true); setCalculationError("");
              try {
                const next = onCalculate ? await onCalculate({ column, rows, prompt: promptRef.current?.textContent ?? "", inputs: selectedInputs, model: meta.tool, grounding, type: meta.type, required: advancedSettings.required, allowEmpty: advancedSettings.allowEmpty, showSourceCoverage: advancedSettings.confidence }) : Object.fromEntries(rows.map(row => [row.id, row.reviewGap ?? "Not assessed"]));
                if (id !== requestId.current) return;
                setValues(next); setCalc({ col: column, resolved: 0 }); setProp(null);
              } catch { if (id === requestId.current) setCalculationError("Could not read results. Try again."); }
              finally { if (id === requestId.current) setCalculating(false); }
            }}
            className="mt-2.5 flex h-9 w-full items-center justify-center gap-2 rounded-[9px] text-[12.5px] font-medium text-ink shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.98] disabled:opacity-60"
          >
            <Icon size={14} strokeWidth={1.9}><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></Icon>
            {calculating ? "Reading…" : onCalculate ? "Run with Iris" : "Preview sample results"}
          </button>

          {calculationError && <p role="alert" className="mt-2 text-[12px] text-red">{calculationError}</p>}
          <GlideMenu className="mt-3 flex flex-col gap-0.5 border-t border-line pt-2" highlightClassName="-inset-x-1.5 rounded-[8px] bg-hover">
            <button
              data-menu-row
              type="button"
              aria-pressed={pinnedColumns.has(prop.col)}
              onClick={() => setPinnedColumns((current) => {
                const next = new Set(current);
                next.has(prop.col) ? next.delete(prop.col) : next.add(prop.col);
                return next;
              })}
              className="relative z-10 -mx-1.5 flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[13px] leading-none text-ink transition-transform duration-150 active:scale-[0.96]"
            >
              <span className={pinnedColumns.has(prop.col) ? "text-accent" : "text-ink-2"}><Icon size={15}><path d="M12 17v5M8 3h8l-1 7 3 3H6l3-3-1-7z" /></Icon></span>
              {pinnedColumns.has(prop.col) ? "Unpin" : "Pin"}
            </button>
            <button
              data-menu-row
              type="button"
              aria-expanded={moreSettingsOpen}
              onClick={() => setMoreSettingsOpen((open) => !open)}
              className="relative z-10 -mx-1.5 flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[13px] leading-none text-ink transition-transform duration-150 active:scale-[0.96]"
            >
              <span className={moreSettingsOpen ? "text-ink" : "text-ink-2"}><Icon size={15}><g><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" /></g></Icon></span>
              <span className="flex-1">More settings</span>
              <span className={`text-ink-3 transition-transform duration-150 ${moreSettingsOpen ? "rotate-90" : ""}`}><Icon size={12} strokeWidth={2.2}><path d="M9 6l6 6-6 6" /></Icon></span>
            </button>
            {prop.col === AI_LABEL && (
              <button
                data-menu-row
                type="button"
                onClick={() => {
                  setAiAdded(false);
                  setAiDone(false);
                  setProp(null);
                }}
                className="relative z-10 -mx-1.5 flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[13px] leading-none text-ink transition-transform duration-150 active:scale-[0.96]"
              >
                <span className="text-ink-2"><Icon size={15}><g><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c7 0 10 7 10 7a16.3 16.3 0 0 1-2.1 3M6.6 6.6A16 16 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6M3 3l18 18" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></g></Icon></span>
                Hide from view
              </button>
            )}
          </GlideMenu>

          {moreSettingsOpen && (
            <div className="mt-2 border-t border-line pt-2" style={{ animation: "fade-up 160ms cubic-bezier(0.23,1,0.32,1) both" }}>
              <div className="pb-1 text-[11.5px] font-medium text-ink-3">Behavior</div>
              <ConfigRow label="Required value">
                <MiniSwitch label="Required value" on={advancedSettings.required} onToggle={() => setAdvancedSettings((current) => ({ ...current, required: !current.required }))} />
              </ConfigRow>
              <ConfigRow label="Allow empty results">
                <MiniSwitch label="Allow empty results" on={advancedSettings.allowEmpty} onToggle={() => setAdvancedSettings((current) => ({ ...current, allowEmpty: !current.allowEmpty }))} />
              </ConfigRow>
              <ConfigRow label="Show source coverage">
                <MiniSwitch label="Show source coverage" on={advancedSettings.confidence} onToggle={() => setAdvancedSettings((current) => ({ ...current, confidence: !current.confidence }))} />
              </ConfigRow>
            </div>
          )}
        </div>
      )}

      {/* ── new property type menu ─────────────────────────── */}
      {addOpen && (
        <div
          data-recpop
          className="fixed z-50 w-[260px] rounded-[14px] bg-surface p-1.5 shadow-overlay"
          style={{ ...menuBounds(addOpen.x, addOpen.y, 260, 390), animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" }}
        >
          <div className="px-2 pb-1 pt-1 text-[12px] font-medium text-ink-3">New property</div>
          <GlideMenu className="flex flex-col gap-px">
            {NEW_PROPERTY_TYPES.map((type) => (
              <button
                key={type}
                data-menu-row
                type="button"
                onClick={() => {
                  setColumnOverrides(current => ({ ...current, [AI_LABEL]: { ...current[AI_LABEL], type } }));
                  setAddOpen(null);
                  setAiDone(false);
                  setAiAdded(true);
                  setPendingOpenAi(true);
                }}
                className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink"
              >
                <span className="text-ink-2"><Icon size={15}>{TYPE_GLYPHS[type]}</Icon></span>
                {type}
              </button>
            ))}
          </GlideMenu>
        </div>
      )}

      {/* ── table options menu ─────────────────────────────── */}
      {tableMenuOpen && (
        <div
          data-recpop
          className="fixed z-50 w-[220px] rounded-[14px] bg-surface p-1.5 shadow-overlay"
          style={{ ...menuBounds(tableMenuOpen.x, tableMenuOpen.y, 220, 235), animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" }}
        >
          <div className="px-2 pb-1 pt-1 text-[12px] font-medium text-ink-3">Table options</div>
          <GlideMenu className="flex flex-col gap-px">
          <button
            data-menu-row
            type="button"
            onClick={() => {
              const position = tableMenuOpen;
              setTableMenuOpen(null);
              setAddOpen({ x: Math.min(position.x, window.innerWidth - 276), y: position.y });
            }}
            className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink"
          >
            <span className="text-ink-2"><Icon size={15} strokeWidth={2}><path d="M12 5v14M5 12h14" /></Icon></span>
            Add property
          </button>
          <button
            data-menu-row
            type="button"
            onClick={() => {
              setColumnWidths({ company: 220, categories: 220, last: 155, strength: 180, links: 160, ai: 200 });
              setTableMenuOpen(null);
            }}
            className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink"
          >
            <span className="text-ink-2"><Icon size={15}><path d="M4 8h16M7 4 3 8l4 4M17 4l4 4-4 4M4 16h16" /></Icon></span>
            Compact columns
          </button>
          <button
            data-menu-row
            type="button"
            onClick={() => {
              setColumnWidths({ ...(initialColumnWidthsRef.current ?? DEFAULT_COLUMN_WIDTHS) });
              setTableMenuOpen(null);
            }}
            className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink"
          >
            <span className="text-ink-2"><Icon size={15}><path d="M3 12a9 9 0 1 0 3-6.7M3 4v6h6" /></Icon></span>
            Reset column widths
          </button>
          <div className="my-1 h-px bg-line" />
          <button
            data-menu-row
            type="button"
            onClick={() => {
              setSelected(new Set());
              onSelectionChange?.([]);
              setTableMenuOpen(null);
            }}
            className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink"
          >
            <span className="text-ink-2"><Icon size={15}><path d="M5 5l14 14M19 5 5 19" /></Icon></span>
            Clear selection
          </button>
          </GlideMenu>
        </div>
      )}
    </div>
  );
}
