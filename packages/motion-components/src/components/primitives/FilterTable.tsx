// Adapted from Beautiful UI — Copyright (c) 2026 Shane Levine, MIT. See LICENSE.beautiful-ui.
"use client";
// SPDX-License-Identifier: MIT — adapted from Beautiful UI; see LICENSE.beautiful-ui.
import { useReducedMotion } from "../../lib/motion";

import { useState } from "react";

/* ─────────────────────────────────────────────────────────
 * FILTER TABLE
 * Status chips directly filter the task table.
 * ───────────────────────────────────────────────────────── */

export type Status = "todo" | "progress" | "done";

export type TableRow = { task: string; date: string; status: Status; owner: string };

export type FilterTableLabels = {
  columns: { task: string; date: string; status: string; owner: string };
};

const FILTERS: { key: "all" | Status; label: string; dot?: string }[] = [
  { key: "all", label: "All" },
  { key: "todo", label: "Needs review", dot: "#f09a2f" },
  { key: "progress", label: "Working", dot: "#16a6c7" },
  { key: "done", label: "Completed", dot: "#25a878" },
];

export const PROGRAM_TASKS: TableRow[] = [
  { task: "Leah application", date: "Oct 12", status: "todo", owner: "Maya Chen" },
  { task: "Owen application", date: "Oct 12", status: "todo", owner: "Maya Chen" },
  { task: "Robin invoice", date: "Oct 12", status: "todo", owner: "Maya Chen" },
  { task: "Services agreement", date: "Oct 12", status: "todo", owner: "Maya Chen" },
  { task: "Compare report gaps", date: "Oct 12", status: "progress", owner: "Iris" },
  { task: "Read program sources", date: "Oct 12", status: "done", owner: "Iris" },
];

const LABELS: FilterTableLabels = {
  columns: { task: "Work", date: "Date", status: "Status", owner: "Owner" },
};

const PILLS: Record<Status, { label: string; cls: string }> = {
  todo: { label: "Needs review", cls: "filter-status-todo" },
  progress: { label: "Working", cls: "filter-status-progress" },
  done: { label: "Completed", cls: "filter-status-done" },
};

export default function FilterTable({
  rows = PROGRAM_TASKS,
  labels = LABELS,
  initialFilter = "all",
  onFilterChange,
  onOpenRow,
}: {
  rows?: TableRow[];
  initialFilter?: "all" | Status;
  onFilterChange?: (filter: "all" | Status) => void;
  onOpenRow?: (row: TableRow) => void;
  labels?: FilterTableLabels;
  variant?: string;
} = {}) {
  const [filter, setFilter] = useState<"all" | Status>(initialFilter);

  const reduce = useReducedMotion();
  return (
    <div data-reduced-motion={reduce} className="hermes-ui w-full max-w-105">
      {/* filter chips */}
      <div
        className="-mx-1 mb-1 flex flex-wrap items-center gap-1 px-1 py-1"
      >
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={active}
              onClick={() => { setFilter(f.key); onFilterChange?.(f.key); }}
              className={`flex h-6.5 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px]
                font-medium transition-[background-color,box-shadow,color] duration-200
                ${active ? "bg-surface text-ink shadow-btn" : "text-ink-2 hover:bg-hover"}`}
            >
              {f.dot && <span className="size-1.5 rounded-full" style={{ background: f.dot }} />}
              {f.label}
              <span
                className={`rounded-[4px] px-1 text-[10.5px] tabular-nums
                  ${active ? "bg-field text-ink-2" : "text-ink-3"}`}
              >
                {f.key === "all" ? rows.length : rows.filter(r => r.status === f.key).length}
              </span>
            </button>
          );
        })}
      </div>

      {/* table */}
      <div
        aria-label="Scrollable task table"
        className="overflow-x-auto rounded-card bg-surface shadow-card"
        role="region"
        tabIndex={0}
        style={{ scrollbarWidth: "none" }}
      >
        <div className="min-w-[420px]">
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,0.75fr)_minmax(0,1.2fr)_minmax(0,1fr)] border-b border-[var(--grid-line)] text-[12.5px] font-medium text-ink-2">
            <span className="border-r border-[var(--grid-line)] px-2 py-2">{labels.columns.task}</span>
            <span className="border-r border-[var(--grid-line)] px-2 py-2">{labels.columns.date}</span>
            <span className="border-r border-[var(--grid-line)] px-2 py-2">{labels.columns.status}</span>
            <span className="px-2 py-2">{labels.columns.owner}</span>
          </div>
          {rows.map((row) => {
            const shown = filter === "all" || row.status === filter;
            const pill = PILLS[row.status];
            return (
              <div
                key={row.task}
                inert={!shown}
                aria-hidden={!shown}
                className="grid transition-[grid-template-rows,opacity] duration-300"
                style={{
                  gridTemplateRows: shown ? "1fr" : "0fr",
                  opacity: shown ? 1 : 0,
                  transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                }}
              >
                <div className="overflow-hidden">
                  <div
                    className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,0.75fr)_minmax(0,1.2fr)_minmax(0,1fr)] border-b
                      border-[var(--grid-line)] text-[13px] transition-colors duration-100 hover:bg-hover"
                  >
                    <span className="flex min-w-0 items-center border-r border-[var(--grid-line)] px-2 py-2">
                      <button type="button" disabled={!onOpenRow} onClick={() => onOpenRow?.(row)} className="min-w-0 whitespace-normal [overflow-wrap:anywhere] text-left font-medium text-ink" title={row.task}>{row.task}</button>
                    </span>
                    <span className="flex min-w-0 items-center whitespace-normal [overflow-wrap:anywhere] border-r border-[var(--grid-line)] px-2 py-2 text-ink-2 tabular-nums">
                      {row.date}
                    </span>
                    <span className="flex min-w-0 items-center border-r border-[var(--grid-line)] px-2 py-2">
                      <span
                        className={`inline-flex min-h-[23px] min-w-0 max-w-full items-center whitespace-normal [overflow-wrap:anywhere] rounded-[8px] border px-[7px] py-px
                          text-[13px] font-medium ${pill.cls}`}
                      >
                        {pill.label}
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center px-2 py-2 text-ink-2">
                      <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{row.owner}</span>
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
