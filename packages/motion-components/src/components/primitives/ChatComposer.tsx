"use client";

/* Adapted from Beautiful UI. Copyright (c) 2026 Shane Levine. MIT License; see LICENSE.beautiful-ui. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "../../lib/motion";

/* Reply sequence: send → 500ms first section → 1400ms second section
 * → 1200ms settled response. Additional sections retain the 1200ms cadence.
 * Layout, entrance and settling curves retain the reference behavior. */
type Phase = "idle" | "sent" | "reply" | "done" | "stopped";

export type ChatMessage = {
  label: string;
  sub: string;
  time: string;
  body: string;
  /** Optional structured findings, rendered as readable rows. */
  details?: { label: string; value: string }[];
};

const MESSAGES: ChatMessage[] = [
  { label: "Read applications", sub: "2 records", time: "4s", body: "Leah and Owen both included integration examples." },
  { label: "Prepared review", sub: "Iris", time: "2s", body: "Both are ready for Maya’s review. Nothing has been sent.", details: [{ label: "Admission", value: "Maya reviews" }, { label: "Access", value: "Alex confirms" }] },
];
const SUGGESTIONS = ["Applications", "Prospects"];

export type ChatComposerLabels = { initialPrompt: string; placeholder: string };
const DEFAULT_LABELS: ChatComposerLabels = {
  initialPrompt: "Screen the new partner applications.",
  placeholder: "Ask Iris, or mention context with @",
};

type Thread = { phase: Phase; draft: string; submitted: string; visible: number; replies: ChatMessage[] };

function Section({ label, sub, time, body, details, resolving }: ChatMessage & { resolving?: boolean }) {
  const reducedMotion = useReducedMotion();
  return (
    <div className="flex w-full flex-col gap-1.5 transition-[opacity,filter,transform] duration-400"
      style={{ opacity: resolving && !reducedMotion ? 0.55 : 1, filter: resolving && !reducedMotion ? "blur(0.5px)" : "blur(0)", transform: resolving && !reducedMotion ? "scale(0.985)" : "scale(1)", transformOrigin: "top left", transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)", animation: reducedMotion ? "none" : "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <div className="flex flex-wrap items-center gap-1 text-[12px] leading-[1.3]">
        <span className="font-medium text-ink">{label}</span><span className="text-ink-2">{sub}</span><span className="text-ink">for {time}</span>
      </div>
      <p className="whitespace-pre-line text-[13px] leading-normal text-ink">{body}</p>
      {details && <dl className="flex flex-col gap-1 rounded-control bg-field px-2 py-1.5 text-[12px]">
        {details.map((item) => <div key={item.label} className="flex justify-between gap-3"><dt className="text-ink-2">{item.label}</dt><dd className="text-ink">{item.value}</dd></div>)}
      </dl>}
    </div>
  );
}

export default function ChatComposer({
  messages = MESSAGES, suggestions = SUGGESTIONS, labels, onSend, onTabChange, onAction, sessionMessages, sessionPrompts, autoplay = false,
}: {
  variant?: string;
  /** Fixture replies; connect onSend to an application to provide real replies. */
  messages?: ChatMessage[];
  suggestions?: string[];
  labels?: Partial<ChatComposerLabels>;
  onSend?: (text: string) => void;
  onTabChange?: (session: string) => void;
  onAction?: (action: "new" | "copy" | "collective" | "stop") => void;
  sessionMessages?: Record<string, ChatMessage[]>;
  sessionPrompts?: Record<string, string>;
  /** Replay the initial fixture; keep off for real conversation surfaces. */
  autoplay?: boolean;
} = {}) {
  const reducedMotion = useReducedMotion();
  const l = { ...DEFAULT_LABELS, ...labels };
  const [extraTabs, setExtraTabs] = useState<string[]>([]);
  const tabs = [...suggestions, ...extraTabs];
  const [tab, setTab] = useState(suggestions[0] ?? "Applications");
  const [threads, setThreads] = useState<Record<string, Thread>>(() => {
    if (!autoplay) return {};
    const session = suggestions[0] ?? "Applications";
    const firstReplies = sessionMessages?.[session] ?? messages;
    return { [session]: { phase: reducedMotion ? "done" : "sent", draft: "", submitted: sessionPrompts?.[session] ?? l.initialPrompt, visible: reducedMotion ? firstReplies.length : 0, replies: firstReplies } };
  });
  const replies = sessionMessages?.[tab] ?? messages;
  const initial: Thread = { phase: "done", draft: "", submitted: sessionPrompts?.[tab] ?? l.initialPrompt, visible: replies.length, replies };
  const thread = threads[tab] ?? initial;
  const { phase, draft, submitted, visible } = thread;
  const busy = phase === "sent" || phase === "reply";
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [feedback, setFeedback] = useState("");
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const update = (patch: Partial<Thread>) => setThreads((current) => ({ ...current, [tab]: { ...(current[tab] ?? initial), ...patch } }));
  useEffect(() => {
    if (!busy) return;
    if (reducedMotion) { update({ phase: "done", visible: thread.replies.length }); return; }
    const delay = phase === "sent" ? 500 : visible === 1 ? 1400 : 1200;
    timerRef.current = setTimeout(() => {
      setThreads((current) => {
        const active = current[tab];
        if (!active || (active.phase !== "sent" && active.phase !== "reply")) return current;
        return { ...current, [tab]: active.visible < active.replies.length
          ? { ...active, phase: "reply", visible: active.visible + 1 }
          : { ...active, phase: "done" } };
      });
    }, delay);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [phase, visible, tab, reducedMotion, busy, thread.replies.length]);
  useEffect(() => () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current); }, []);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    update({ phase: reducedMotion ? "done" : "sent", submitted: text, draft: "", visible: reducedMotion ? replies.length : 0, replies });
    onSend?.(text);
  };
  const stop = () => { if (timerRef.current) clearTimeout(timerRef.current); update({ phase: "stopped" }); onAction?.("stop"); inputRef.current?.focus(); };
  const act = async (action: "new" | "copy" | "collective") => {
    if (action === "new") {
      const name = `Session ${extraTabs.length + suggestions.length + 1}`;
      setExtraTabs((current) => [...current, name]);
      setThreads((current) => ({ ...current, [name]: { phase: "idle", draft: "", submitted: "", visible: 0, replies } }));
      setTab(name);
      inputRef.current?.focus();
    } else if (action === "copy") {
      try {
        await navigator.clipboard.writeText(thread.replies.slice(0, visible).map((message) => [message.body, ...(message.details?.map((item) => `${item.label}: ${item.value}`) ?? [])].join("\n")).join("\n\n"));
        setFeedback("Response copied");
      } catch { setFeedback("Couldn’t copy. Select the response to copy it."); }
    } else { setFeedback("Ready to add to Collective"); }
    onAction?.(action);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(""), 2200);
  };
  const actions: { action: "new" | "copy" | "collective"; label: string; icon: ReactNode }[] = [
    { action: "new", label: "New session", icon: <path d="M12 5v14M5 12h14" /> },
    { action: "copy", label: "Copy response", icon: <g><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M5 15H4V4h11v1" /></g> },
    { action: "collective", label: "Add to Collective", icon: <g><path d="m12 3-9 5v9l9 5 9-5V8zM3 8l9 5 9-5M12 13v9" /></g> },
  ];

  return (
    <div data-reduced-motion={reducedMotion || undefined} className="flex h-[288px] w-full max-w-95 flex-col self-start overflow-hidden rounded-[14px] bg-surface shadow-card">
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-line p-1.5">
        <div className="flex min-w-0 items-center overflow-x-auto" aria-label="Sessions">
          {tabs.map((item) => <button key={item} type="button" aria-pressed={tab === item} onClick={() => { setTab(item); onTabChange?.(item); }} className={`shrink-0 rounded-[6px] px-2 py-[3px] text-[13px] text-ink transition-[background-color,opacity] duration-100 ${tab === item ? "bg-field" : "opacity-50 hover:opacity-75"}`}>{item}</button>)}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions.map(({ action, label, icon }) => <button key={action} type="button" aria-label={label} title={label} disabled={action !== "new" && !visible} onClick={() => void act(action)} className="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink-2 disabled:opacity-30"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icon}</svg></button>)}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pt-2.5 pb-1" aria-label={`${tab} conversation`} aria-busy={busy}>
        {phase !== "idle" && <div className="flex justify-end pl-14"><div className="rounded-xl bg-field px-3 py-1.5 text-[13px] leading-[1.4] text-ink transition-[opacity,transform] duration-300" style={{ animation: reducedMotion ? "none" : "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }} key={submitted}>{submitted}</div></div>}
        {thread.replies.slice(0, visible).map((message, index) => <Section key={`${submitted}-${index}`} {...message} resolving={phase === "reply" && visible > 1 && index === visible - 1} />)}
        {phase === "sent" && <span role="status" className="text-[12px] text-ink-2" style={{ animation: reducedMotion ? "none" : "shimmer-text 1.4s linear infinite" }}>Iris is checking the context…</span>}
        {phase === "stopped" && <span role="status" className="text-[12px] text-ink-2">Stopped. Saved replies remain here.</span>}
        <span role="status" className="sr-only">{feedback}</span>
      </div>
      <div className="mt-auto shrink-0 p-1.5">
        <div role="presentation" onClick={() => inputRef.current?.focus()} className="flex cursor-text flex-col gap-2 rounded-control border border-line bg-field p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow] duration-150 focus-within:border-line-strong">
          <input ref={inputRef} value={draft} onChange={(event) => update({ draft: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} placeholder={l.placeholder} aria-label="Chat prompt" className="min-h-4.5 bg-transparent text-[13px] leading-[1.4] text-ink outline-none placeholder:text-ink-3" />
          <div className="flex items-center justify-end">
            <button type="button" aria-label={busy ? "Stop response" : "Send"} disabled={!busy && !draft.trim()} onClick={busy ? stop : send} className="flex size-7 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96]" style={{ background: busy || draft.trim() ? "var(--accent)" : "var(--line-strong)", color: "var(--ink)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">{busy ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /> : <path d="M12 19V5M5 12l7-7 7 7" />}</svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
