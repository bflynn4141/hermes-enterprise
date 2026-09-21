// Adapted from Beautiful UI — Copyright (c) 2026 Shane Levine, MIT. See LICENSE.beautiful-ui.
"use client";
// SPDX-License-Identifier: MIT — adapted from Beautiful UI; see LICENSE.beautiful-ui.

import { useReducedMotion } from "../../lib/motion";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/* ─────────────────────────────────────────────────────────
 * CODE BLOCK
 * A light editor panel with two versions (switch in the card):
 *   · Code — a line-numbered listing
 *   · Diff — a unified diff: old/new gutters, a green/red accent
 *     bar and row tint, plus word-level add/del highlights.
 * Both share syntax coloring, insets, and wrapping behavior.
 * ───────────────────────────────────────────────────────── */

const FILE = "partner-review.ts";

const CODE_LINES = [
  "export async function reviewPartner(application) {",
  '  const criteria = await read("Partner criteria v2");',
  "  const report = await screen(application, criteria);",
  '  report.evidenceOrder = "gaps-first";',
  '  report.requiredReviewer = "Maya Chen";',
  '  return queueReview(report, { send: false });',
  "}",
];

/* A single run of code within a diff row; `change` tints it as an add/del. */
export type CodePiece = { text: string; change?: "add" | "del" };
/* One row of a unified diff: old/new line numbers, its kind, and its pieces. */
export type DiffRow = {
  old: number | null;
  cur: number | null;
  type: "ctx" | "add" | "del";
  pieces: CodePiece[];
};
/* Prominent copy strings on the code block. */
export type CodeBlockLabels = { copy: string; copied: string };

// Back-compat internal aliases for the local component signatures.
type Piece = CodePiece;
type Row = DiffRow;

const DIFF: Row[] = [
  { old: 1, cur: 1, type: "ctx", pieces: [{ text: CODE_LINES[0] }] },
  { old: 2, cur: 2, type: "ctx", pieces: [{ text: CODE_LINES[1] }] },
  { old: 3, cur: 3, type: "ctx", pieces: [{ text: CODE_LINES[2] }] },
  { old: 4, cur: null, type: "del", pieces: [{ text: "  report.evidenceOrder = " }, { text: '"source-order"', change: "del" }, { text: ";" }] },
  { old: null, cur: 4, type: "add", pieces: [{ text: "  report.evidenceOrder = " }, { text: '"gaps-first"', change: "add" }, { text: ";" }] },
  { old: 5, cur: 5, type: "ctx", pieces: [{ text: CODE_LINES[4] }] },
  { old: 6, cur: 6, type: "ctx", pieces: [{ text: CODE_LINES[5] }] },
  { old: 7, cur: 7, type: "ctx", pieces: [{ text: CODE_LINES[6] }] },
];

const HATCH = "repeating-linear-gradient(45deg, var(--red) 0, var(--red) 1.5px, transparent 1.5px, transparent 3px)";

/* light syntax coloring — keywords/imports/conditionals, functions, strings & numbers */
const KEYWORDS = new Set(["import", "from", "export", "default", "async", "function", "const", "let", "var", "await", "return", "if", "else", "for", "while", "new", "throw", "try", "catch", "null", "true", "false", "undefined"]);
// Match identifiers unconditionally; deciding whether they are calls outside the
// regex avoids quadratic lookahead backtracking on adversarial input.
const TOKEN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined)\b|[A-Za-z_$][A-Za-z0-9_$]*)/g;

function isFunctionCall(text: string, tokenEnd: number): boolean {
  let cursor = tokenEnd;
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  return text[cursor] === "(";
}

function highlight(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    const t = m[0];
    let color: string;
    let weight: number | undefined;
    if (/^["'`]/.test(t) || /^\d/.test(t)) color = "var(--orange)"; // string / number
    else if (KEYWORDS.has(t)) color = "var(--accent-ink)"; // keyword / import / conditional
    else if (isFunctionCall(text, idx + t.length)) { color = "var(--ink)"; weight = 500; } // function call
    else continue;
    if (idx > last) nodes.push(<span key={k++}>{text.slice(last, idx)}</span>);
    nodes.push(<span key={k++} style={{ color, fontWeight: weight }}>{t}</span>);
    last = idx + t.length;
  }
  if (last < text.length) nodes.push(<span key={k++}>{text.slice(last)}</span>);
  return nodes;
}

function Pieces({ pieces }: { pieces: Piece[] }) {
  return (
    <>
      {pieces.map((p, i) => {
        if (p.change) {
          const add = p.change === "add";
          return (
            <span
              key={i}
              className="rounded-[3px]"
              style={{
                background: `color-mix(in srgb, var(--${add ? "green" : "red"}) 18%, transparent)`,
                padding: "0 2px",
                margin: "0 -1px",
                boxDecorationBreak: "clone",
                WebkitBoxDecorationBreak: "clone",
              }}
            >
              {highlight(p.text)}
            </span>
          );
        }
        return <span key={i}>{highlight(p.text)}</span>;
      })}
    </>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-3">
      <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
    </svg>
  );
}

const DEFAULT_LABELS: CodeBlockLabels = { copy: "Copy", copied: "Copied" };

export type CodeBlockProps = {
  /** Which view to render — "Code" (line-numbered listing) or "Diff". */
  variant?: string;
  /** The lines shown in the Code view. */
  lines?: string[];
  /** Raw text placed on the clipboard by Copy. Defaults to `lines` joined. */
  code?: string;
  /** The unified-diff rows shown in the Diff view. */
  diff?: DiffRow[];
  /** Filename shown in the header. */
  filename?: string;
  /** Prominent copy strings. */
  labels?: Partial<CodeBlockLabels>;
  /** Called with the copied text after a successful copy. */
  onCopy?: (text: string) => void;
  onCopyError?: (error: unknown) => void;
};

export default function CodeBlock({
  variant = "Code",
  lines = CODE_LINES,
  code,
  diff = DIFF,
  filename = FILE,
  labels,
  onCopy,
  onCopyError,
}: CodeBlockProps = {}) {
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState(false);
  const isDiff = variant === "Diff";
  const text = { ...DEFAULT_LABELS, ...labels };
  const raw = code ?? lines.join("\n");

  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);
  const copy = useCallback(async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      onCopy?.(raw);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch (error) { setCopied(false); setCopyError(true); onCopyError?.(error); }
  }, [raw, onCopy, onCopyError]);

  const added = diff.filter((r) => r.type === "add").length;
  const removed = diff.filter((r) => r.type === "del").length;

  return (
    <div data-reduced-motion={reduce} className="hermes-ui w-full max-w-105 overflow-hidden rounded-card bg-surface shadow-card">
      {/* header — file · (diff stat | copy) */}
      <div className="flex h-11 items-center gap-2 border-b border-line px-4 text-[12.5px]">
        <span className="inline-flex min-w-0 items-center gap-[7px]">
          <FileIcon />
          <span className="truncate font-mono leading-none text-ink">{filename}</span>
        </span>

        {isDiff ? (
          <span className="ml-auto inline-flex items-center gap-2 font-mono text-[12px] leading-none tabular-nums">
            <span className="text-green">+{added}</span>
            <span className="text-red">-{removed}</span>
          </span>
        ) : (
          <button
            type="button"
            aria-label="Copy code"
            onClick={copy}
            className={`-mr-1 ml-auto flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[12px]
              font-medium transition-colors duration-100 hover:bg-hover
              ${copied ? "text-green" : "text-ink-3 hover:text-ink"}`}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            )}
            {copied ? text.copied : text.copy}
          </button>
        )}
      </div>

      {copyError && <p role="alert" className="px-4 pt-2 text-[12px] text-red">Clipboard unavailable. Select the text to copy.</p>}
      {/* body — equal 12px inset on top / left / right; lines wrap */}
      <div className="py-3 font-mono text-[12.5px] leading-[1.65] text-ink-2">
        {isDiff ? (
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-5 w-px bg-line" />
            {diff.map((r, i) => {
              const add = r.type === "add";
              const del = r.type === "del";
              // one gutter column: removals keep the old number, additions/context show the new one
              const num = del ? r.old : r.cur;
              return (
                <div
                  key={i}
                  className={`relative grid grid-cols-[20px_minmax(0,1fr)] items-start
                    ${add ? "bg-green-tint" : del ? "bg-red-tint" : ""}`}
                >
                  {(add || del) && (
                    <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: add ? "var(--green)" : HATCH }} />
                  )}
                  <span className={`select-none text-center text-[11px] ${add ? "text-green" : del ? "text-red" : "text-ink-3"}`}>{num ?? ""}</span>
                  <code className="pr-3 pl-1 break-words whitespace-pre-wrap">
                    <Pieces pieces={r.pieces} />
                  </code>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-5 w-px bg-line" />
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-[20px_minmax(0,1fr)] items-start">
                <span className="select-none text-center text-[11px] text-ink-3">{i + 1}</span>
                <code className="pr-3 pl-1 break-words whitespace-pre-wrap">{highlight(line)}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
