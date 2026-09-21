/* Adapted from Beautiful UI. Copyright (c) 2026 Shane Levine. MIT License; see LICENSE.beautiful-ui. */
"use client";

import { useRef, useState } from "react";
import GlideMenu from "./GlideMenu";

/* ─────────────────────────────────────────────────────────
 * SEARCH — command search with live filtering.
 * The field, clear action, and results are directly usable.
 * ───────────────────────────────────────────────────────── */

export type SearchItem = string;

export type SearchListLabels = {
  placeholder: string;
  ariaLabel: string;
  emptyTitle: string;
  emptyHint: string;
};

const ITEMS: SearchItem[] = [
  "Screen partner applications",
  "Find potential partners",
  "Review the services agreement",
  "Check invoice evidence",
  "Find shared screening skills",
  "Summarize partner feedback",
  "Check permission settings",
];

const LABELS: SearchListLabels = {
  placeholder: "Search Iris…",
  ariaLabel: "Search Iris",
  emptyTitle: "No results found",
  emptyHint: "Adjust your search to try again",
};

export default function SearchList({
  items = ITEMS,
  labels = LABELS,
  onSelect,
}: {
  items?: SearchItem[];
  labels?: SearchListLabels;
  onSelect?: (item: SearchItem) => void;
  variant?: string;
} = {}) {
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const results = query
    ? items.filter((i) => i.toLowerCase().includes(query.toLowerCase()))
    : items.slice(0, 5);
  const empty = results.length === 0;

  return (
    <div className="flex min-h-[248px] w-full max-w-72 flex-col items-stretch">
      <div className="w-full self-start overflow-hidden rounded-card bg-surface shadow-raised">
        {/* input row */}
        <div className="flex h-10 items-center gap-2 border-b border-line px-3 transition-colors duration-100 hover:bg-hover">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round" className="shrink-0">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); rowRefs.current[0]?.focus(); } if (event.key === "Enter" && results[0]) { setQuery(results[0]); onSelect?.(results[0]); } if (event.key === "Escape") setQuery(""); }}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.placeholder}
            aria-label={labels.ariaLabel}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
          {query && (
            <button
              aria-label="Clear search"
              type="button"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="flex size-6 items-center justify-center rounded-full text-ink-3
                transition-colors duration-100 hover:bg-line/70 hover:text-ink"
              style={{ animation: "fade-in 150ms ease-out both" }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* results / empty state */}
        {empty ? (
          <div className="flex flex-col items-center justify-center gap-1 px-4 py-8" style={{ animation: "fade-in 250ms ease-out both" }}>
            <span className="mb-1.5 flex size-8 items-center justify-center rounded-control bg-inset text-ink-3 shadow-hairline">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </span>
            <span className="text-[13px] font-medium text-ink">{labels.emptyTitle}</span>
            <span className="text-[12px] text-ink-3">{labels.emptyHint}</span>
          </div>
        ) : (
          <div className="p-1">
            <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
              {results.map((item, index) => (
                <button
                  key={item}
                  ref={(element) => { rowRefs.current[index] = element; }}
                  onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); rowRefs.current[(index + 1) % results.length]?.focus(); } if (event.key === "ArrowUp") { event.preventDefault(); if (index === 0) inputRef.current?.focus(); else rowRefs.current[index - 1]?.focus(); } if (event.key === "Escape") inputRef.current?.focus(); }}
                  data-menu-row
                  type="button"
                  onClick={() => { setQuery(item); onSelect?.(item); }}
                  className="relative z-10 flex h-8 w-full items-center rounded-[6px] px-2 text-left text-[13px] text-ink"
                  style={{ animation: "fade-in 200ms ease-out both" }}
                >
                  {item}
                </button>
              ))}
            </GlideMenu>
          </div>
        )}
      </div>
    </div>
  );
}
