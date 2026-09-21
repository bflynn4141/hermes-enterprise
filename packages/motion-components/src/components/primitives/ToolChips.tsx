"use client";

/* Adapted from Beautiful UI. Copyright (c) 2026 Shane Levine. MIT License; see LICENSE.beautiful-ui. */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "../../lib/motion";

/* ─────────────────────────────────────────────────────────
 * TOOL CHIPS
 * An agent run as compact rows: tool calls with inline
 * chips, then file-diff chips summarizing the edits.
 * Hover a row to reveal its chevron; every row expands
 * to show what the tool actually did.
 * ───────────────────────────────────────────────────────── */

const STEP_MS = 700;

const Icons: Record<string, React.ReactNode> = {
  think: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
  write: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></g>,
  run: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17l6-5-6-5M12 19h8" /></g>,
  read: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></g>,
};

export type ToolDetailLine = { text: string; tone?: "add" };

export type ToolStep = {
  icon: string;
  label: string;
  chip: string;
  mono: boolean;
  detailMono: boolean;
  detail: ToolDetailLine[];
};

export type ToolDiff = { file: string; add: number; del: number };

export type ToolDiffLine = { text: string; tone: "add" | "del" | "ctx" };

export type ToolChipsLabels = {
  header: string;
  more: string;
};

const DEFAULT_LABELS: ToolChipsLabels = {
  header: "4 tool calls",
  more: "View all changes",
};

const ROWS: ToolStep[] = [
  {
    icon: "read", label: "Read criteria", chip: "partner-criteria.md", mono: true, detailMono: false,
    detail: [{ text: "Proposed criteria · integration evidence required." }, { text: "Admission and access need human review." }],
  },
  {
    icon: "read", label: "Read applications", chip: "Leah + Owen", mono: false, detailMono: false,
    detail: [{ text: "2 applications with integration examples." }, { text: "No access has been granted." }],
  },
  {
    icon: "run", label: "Check evidence", chip: "verify-applications", mono: true, detailMono: true,
    detail: [{ text: "✓ 2 application records checked" }, { text: "✓ Missing fields marked for review" }],
  },
  {
    icon: "write", label: "Save summaries", chip: "review-notes.md", mono: true, detailMono: false,
    detail: [{ text: "2 drafts saved for Maya." }, { text: "Nothing sent. Decisions remain in Inbox." }],
  },
];

const DIFFS: ToolDiff[] = [
  { file: "review-notes.md", add: 2, del: 0 },
  { file: "screening.json", add: 1, del: 1 },
  { file: "follow-ups.md", add: 1, del: 0 },
];

const DIFF_LINES: Record<string, ToolDiffLine[]> = {
  "review-notes.md": [
    { text: "# Application review", tone: "ctx" },
    { text: "Leah: integration example attached.", tone: "add" },
    { text: "Owen: integration example attached.", tone: "add" },
  ],
  "screening.json": [
    { text: '"status": "unscreened"', tone: "del" },
    { text: '"status": "needs_review"', tone: "add" },
    { text: '"reviewer": "Maya Chen"', tone: "ctx" },
  ],
  "follow-ups.md": [
    { text: "Confirm onboarding availability after admission.", tone: "add" },
  ],
};

export default function ToolChips({
  steps = ROWS,
  diffs = DIFFS,
  diffLines = DIFF_LINES,
  labels,
  className,
  onOpenChange,
  onToggleRow,
  onMore,
}: {
  /** Accepted for gallery/registry parity; ToolChips has no visual variants. */
  variant?: string;
  steps?: ToolStep[];
  diffs?: ToolDiff[];
  diffLines?: Record<string, ToolDiffLine[]>;
  labels?: Partial<ToolChipsLabels>;
  className?: string;
  onOpenChange?: (open: boolean) => void;
  onToggleRow?: (label: string, open: boolean) => void;
  onMore?: () => void;
} = {}) {
  const reducedMotion = useReducedMotion();
  const copy = { ...DEFAULT_LABELS, header: `${steps.length} tool calls`, ...labels };
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  /* Rendered in a body portal so animated/translated reply wrappers cannot
   * redefine the fixed-position coordinate system. */
  const [preview, setPreview] = useState<{
    file: string;
    x: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const openPreview = (file: string) => (event: React.SyntheticEvent) => {
    const rect = (event.currentTarget as Element).closest("[data-diffchip]")!.getBoundingClientRect();
    const previewHeight = 38 + (diffLines[file]?.length ?? 0) * 19;
    const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
    setPreview({
      file,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...(fitsBelow
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };
  const closePreview = (file: string) => () =>
    setPreview((current) => (current?.file === file ? null : current));
  const total = steps.length + 1; // rows, then diff chips

  useEffect(() => {
    if (reducedMotion || step >= total) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [step, total, reducedMotion]);

  useEffect(() => {
    if (!preview) return;
    const close = () => setPreview(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", escape);
    };
  }, [preview]);

  const toggleRow = (label: string) => {
    const next = new Set(openRows);
    next.has(label) ? next.delete(label) : next.add(label);
    setOpenRows(next);
    onToggleRow?.(label, next.has(label));
  };

  return (
    <div data-reduced-motion={reducedMotion || undefined} className={`min-h-[220px] w-full max-w-80 pb-1${className ? ` ${className}` : ""}`}>
      {/* collapsed run header */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen(!open); onOpenChange?.(!open); }}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="tabular-nums">{copy.header}</span>
      </button>

      {/* tool call rows */}
      <div inert={!open} className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}>
        {/* -mx-1 + px-1.5 keeps content at the same x while giving the
            row hover pills room inside this overflow-hidden clip box */}
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
        <div className="mt-1.5 flex flex-col gap-1">
          {steps.slice(0, reducedMotion ? steps.length : step).map((row) => {
            const rowOpen = openRows.has(row.label);
            return (
            <div key={row.label} style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
              <button
                type="button"
                aria-expanded={rowOpen}
                onClick={() => toggleRow(row.label)}
                className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 hover:bg-hover-2"
              >
                <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                  <svg
                    width="13" height="13" viewBox="0 0 24 24" fill={row.icon === "think" ? "currentColor" : "none"} stroke="currentColor"
                    className={`transition-opacity duration-100 group-hover/row:opacity-0 ${rowOpen ? "opacity-0" : ""}`}
                  >
                    {Icons[row.icon]}
                  </svg>
                  <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                    className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${rowOpen ? "opacity-100" : "opacity-0"}`}
                    style={{ transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </span>
                <span className="shrink-0 text-[12.5px] font-medium text-ink">{row.label}</span>
                <span
                  className={`inline-flex h-5.5 min-w-0 flex-1 cursor-pointer items-center truncate rounded-chip bg-field px-1.5
                    text-[11.5px] text-ink-2 shadow-hairline transition-colors duration-100 hover:bg-hover-2
                    ${row.mono ? "font-mono" : ""}`}
                >
                  {row.chip}
                </span>
              </button>

              {/* expanded detail */}
              <div
                inert={!rowOpen}
                className="grid transition-[grid-template-rows,opacity] duration-300"
                style={{ gridTemplateRows: rowOpen ? "1fr" : "0fr", opacity: rowOpen ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-line py-0.5 pl-3.5">
                    {row.detail.map((line) => (
                      <span
                        key={line.text}
                        className={`truncate text-[11.5px] leading-[1.6] ${row.detailMono ? "font-mono" : ""} ${line.tone === "add" ? "text-green" : "text-ink-2"}`}
                      >
                        {line.text}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            );
          })}
        </div>

      {/* file-diff chips */}
      {(reducedMotion || step >= total) && (
        <div className="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2.5">
          {diffs.map((d, i) => (
            <span
              key={d.file}
              data-diffchip
              className="relative"
              onMouseEnter={openPreview(d.file)}
              onMouseLeave={closePreview(d.file)}
            >
              <button
                type="button"
                aria-expanded={preview?.file === d.file}
                aria-label={`Show diff for ${d.file}`}
                onFocus={openPreview(d.file)}
                onClick={openPreview(d.file)}
                onKeyDown={(event) => { if (event.key === "Escape") setPreview(null); }}
                onBlur={closePreview(d.file)}
                className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip
                  bg-surface px-2 font-mono text-[11.5px] text-ink shadow-btn
                  transition-colors duration-100 hover:bg-hover"
                style={{ animation: `pop-in 250ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both` }}
              >
                <span className="min-w-0 truncate">{d.file}</span>
                <span className="shrink-0 text-green tabular-nums">+{d.add}</span>
                {d.del > 0 && <span className="shrink-0 text-red tabular-nums">−{d.del}</span>}
              </button>

            </span>
          ))}
          {onMore && <button
            type="button"
            onClick={onMore}
            className="inline-flex h-7 items-center rounded-chip px-1.5 font-mono text-[11.5px] text-ink-3
              underline decoration-transparent underline-offset-2 transition-colors duration-100
              hover:text-ink-2 hover:decoration-current"
            style={{ animation: `fade-in 300ms ease-out ${diffs.length * 80}ms both` }}
          >
            {copy.more}
          </button>}
        </div>
      )}
        </div>
      </div>
      {preview && typeof document !== "undefined" && createPortal(
        <div
          role="tooltip"
          data-reduced-motion={reducedMotion || undefined}
          className="hermes-ui fixed z-50 w-72 overflow-hidden rounded-[10px] bg-surface shadow-overlay"
          style={{
            left: preview.x,
            top: preview.top,
            bottom: preview.bottom,
            animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
            transformOrigin: preview.top === undefined ? "bottom left" : "top left",
          }}
        >
          <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 font-mono text-[11px]">
            <span className="min-w-0 truncate text-ink-2">{preview.file}</span>
            <span className="shrink-0 tabular-nums">
              <span className="text-green">+{diffs.find((diff) => diff.file === preview.file)?.add}</span>
              {(diffs.find((diff) => diff.file === preview.file)?.del ?? 0) > 0 && (
                <span className="text-red"> −{diffs.find((diff) => diff.file === preview.file)?.del}</span>
              )}
            </span>
          </div>
          <div className="py-1 font-mono text-[11px] leading-[1.8]">
            {(diffLines[preview.file] ?? []).map((line, index) => (
              <div
                key={index}
                className={`flex gap-2 px-2.5 whitespace-pre ${
                  line.tone === "add"
                    ? "bg-green-tint text-green"
                    : line.tone === "del"
                      ? "bg-red-tint text-red"
                      : "text-ink-2"
                }`}
              >
                <span className="w-3 shrink-0 select-none">{line.tone === "add" ? "+" : line.tone === "del" ? "−" : " "}</span>
                <span className="min-w-0 truncate">{line.text}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
