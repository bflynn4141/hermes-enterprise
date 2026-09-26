// Adapted from Beautiful UI — Copyright (c) 2026 Shane Levine, MIT. See LICENSE.beautiful-ui.
"use client";
// SPDX-License-Identifier: MIT — adapted from Beautiful UI; see LICENSE.beautiful-ui.
import { useReducedMotion } from "../../lib/motion";

import { useEffect, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * CONTEXT CARDS
 * Retrieved chunks enter once, then remain available.
 * ───────────────────────────────────────────────────────── */

export type ContextChunk = {
  title: string;
  chars: string;
  body: string;
  source: string;
  badge: string;
  tone: string;
};

export type ContextCardsLabels = {
  header: string;
  count: string;
};

const DEFAULT_LABELS: ContextCardsLabels = {
  header: "Cited context",
  count: "",
};

export const PARTNER_CONTEXT: ContextChunk[] = [
  { title: "Admission review", chars: "Program rule", body: "Iris screens each application against cited criteria. Maya decides admission and the exact role benefits.", source: "Partner criteria v2.md", badge: "MD", tone: "bg-accent" },
  { title: "Verified delivery", chars: "Invoice source", body: "Maya accepted Robin’s October 8 workshop and October 9 resource pack. The fees are $900 and $300.", source: "Delivery statement.pdf", badge: "PDF", tone: "bg-accent" },
];

export default function ContextCards({
  chunks = PARTNER_CONTEXT,
  labels,
  className,
  onOpenSource,
}: {
  /** Accepted for gallery/registry parity; ContextCards has no visual variants. */
  variant?: string;
  chunks?: ContextChunk[];
  onOpenSource?: (chunk: ContextChunk) => void;
  labels?: Partial<ContextCardsLabels>;
  className?: string;
} = {}) {
  const reduce = useReducedMotion();
  const [chipsShown, setChipsShown] = useState(false);
  const copy = { ...DEFAULT_LABELS, count: String(chunks.length), ...labels };

  useEffect(() => {
    if (reduce) { setChipsShown(true); return; }
    const chips = setTimeout(() => setChipsShown(true), 700);
    return () => clearTimeout(chips);
  }, [reduce]);

  return (
    <div data-reduced-motion={reduce} className={`hermes-ui flex w-full max-w-95 flex-col gap-2${className ? ` ${className}` : ""}`}>
      <div
        className="flex items-center gap-2 px-0.5"
        style={{ animation: reduce ? "none" : "fade-in 400ms ease-out both" }}
      >
        <span className="text-[13px] font-semibold text-ink">{copy.header}</span>
        <span className="inline-flex h-5 items-center rounded-md bg-inset px-1.5 text-[11.5px] font-medium text-ink-2 shadow-hairline tabular-nums">
          {copy.count}
        </span>
      </div>

      {chunks.map((chunk, i) => (
        <div
          key={chunk.title}
          className="overflow-hidden rounded-card bg-surface shadow-card"
          style={{
            animation: reduce ? "none" : `fade-up 400ms cubic-bezier(0.23,1,0.32,1) ${i * 100}ms both`,
          }}
        >
          <div className="primitive-card-bar flex items-center gap-2.5 border-b border-line">
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
              <span className="truncate">{chunk.title}</span>
            </span>
            <span className="ml-auto shrink-0 text-[12px] text-ink-3 tabular-nums">{chunk.chars}</span>
          </div>
          <p className="px-3 pt-2 pb-1 text-[12.5px] leading-relaxed text-ink-2">
            {chunk.body}
          </p>
          <div className="px-3 pb-3">
            <button
              type="button"
              tabIndex={chipsShown ? 0 : -1}
              disabled={!onOpenSource}
              onClick={() => onOpenSource?.(chunk)}
              className="inline-flex h-6 items-center gap-1.5 rounded-full bg-inset px-2
                text-[12px] font-medium text-ink-2 shadow-btn
                transition-[opacity,transform,background-color] duration-300 hover:bg-hover"
              style={{
                opacity: chipsShown ? 1 : 0,
                transform: chipsShown ? "scale(1)" : "scale(0.95)",
                transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                transitionDelay: `${i * 80}ms`,
              }}
            >
              <span className={`flex size-3.5 items-center justify-center rounded-[4px] ${chunk.tone} text-[7px] font-bold text-white`}>
                {chunk.badge}
              </span>
              {chunk.source}
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M7 7h10v10" /></svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
