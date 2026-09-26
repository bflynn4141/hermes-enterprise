// Adapted from Beautiful UI — Copyright (c) 2026 Shane Levine, MIT. See LICENSE.beautiful-ui.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "../../lib/motion";
import { PartnerWorkspacePreview } from "./AgentScreen";

/* ─────────────────────────────────────────────────────────
 * LOADING STATE — pixel-grid loader for long-running work
 *
 * Variants:
 *   Drive  — square cells, chevron wavefront driving right;
 *            the 650ms cycle is shorter than the sweep, so
 *            two fronts are always in flight
 *   Dots   — same wavefront, circular cells
 *   Orbit  — a comet lapping the grid perimeter
 *   Surfer — the Drive loader paired with a meme video below
 *
 * Paired with a shimmering label and a live elapsed timer
 * in mono tabular figures. Reduced motion freezes the grid
 * to its dim state; the timer still ticks.
 * ───────────────────────────────────────────────────────── */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS: Record<string, { delays: (number | null)[]; dur: number; round: boolean }> = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

function LoaderGrid({
  delays,
  dur,
  round,
}: {
  delays: (number | null)[];
  dur: number;
  round: boolean;
}) {
  return (
    <span aria-hidden data-loader-grid className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {delays.map((delay, index) => (
        <span
          key={index}
          className={`size-[4px] bg-ink ${round ? "rounded-full" : "rounded-[1px]"}`}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null ? "none" : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

function useElapsed(active: boolean) {
  const [ds, setDs] = useState(0);
  const accumulated = useRef(0);
  useEffect(() => {
    if (!active) return;
    const start=Date.now();
    const t = setInterval(() => setDs(Math.floor((accumulated.current+Date.now()-start)/100)), 100);
    return () => { accumulated.current += Date.now()-start; clearInterval(t); };
  }, [active]);
  const total = ds / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

export default function LoadingState({
  label,
  variant = "Drive",
  /** Optional media for the Context variant; otherwise use a supplied context node. */
  videoSrc,
  context,
  active = true,
}: {
  label?: string;
  variant?: string;
  videoSrc?: string;
  context?: ReactNode;
  active?: boolean;
}) {
  const reduce = useReducedMotion();
  const elapsed = useElapsed(active);
  const surfer = variant === "Surfer" || variant === "Context";
  const resolvedLabel = label ?? (active ? "Reviewing partner criteria" : "Paused");
  const [videoOk, setVideoOk] = useState(true);
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.Drive;

  const labelEl = (
    <span
      data-loader-label
      className="bg-clip-text text-[13px] font-medium text-transparent"
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
        backgroundSize: "200% 100%",
        animation: active && !reduce ? "shimmer-text 1.4s linear infinite" : "none",
      }}
    >
      {resolvedLabel}
    </span>
  );
  const elapsedEl = <span className="font-mono text-[12px] text-ink-3 tabular-nums">{elapsed}</span>;

  if (surfer) {
    return (
      <div role="status" data-active={active} className="flex w-fit flex-col items-start" style={{animationPlayState:active?"running":"paused"}}>
        <div className="flex items-center gap-2.5">
          <LoaderGrid {...PATTERNS.Drive} />
          {labelEl}
          {elapsedEl}
        </div>

        {/* the context card follows the status text it is illustrating */}
        <div
          className="mt-3 w-full max-w-[420px] overflow-hidden rounded-[10px] shadow-overlay"
          style={{ animation: "pop-in 200ms cubic-bezier(0.16,1,0.3,1) both", transformOrigin: "top left" }}
        >
          <div className="relative w-full" style={{ background: "var(--tooltip-bg)" }}>
            {videoSrc && videoOk ? (
              <video
                src={videoSrc}
                autoPlay={!reduce && active}
                muted
                loop={!reduce}
                playsInline
                onError={() => setVideoOk(false)}
                className="h-full w-full object-cover"
              />
            ) : (
              <>{context || <PartnerWorkspacePreview />}</>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div role="status" data-active={active} className="flex w-fit items-center gap-2.5">
      <LoaderGrid delays={delays} dur={dur} round={round} />
      {labelEl}
      {elapsedEl}
    </div>
  );
}
