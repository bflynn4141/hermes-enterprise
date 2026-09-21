/* Adapted from Beautiful UI. Copyright (c) 2026 Shane Levine. MIT License; see LICENSE.beautiful-ui. */
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  ChatBubbleQuestion,
  Check,
  EmojiSatisfied,
  NavArrowRight,
  Refresh,
  Scissor,
  Spark,
  TextBox,
  Xmark,
} from "iconoir-react";
import { Button } from "../atoms/Button";
import { Shimmer } from "../atoms/Shimmer";
import { StreamText } from "../atoms/StreamText";
import { useReducedMotion } from "../../lib/motion";

/* ─────────────────────────────────────────────────────────
 * SELECTION ACTIONS
 * A contextual AI bar attached beneath selected text.
 * The global theme owns its surface; this component only
 * composes existing surface, ink, accent, radius and motion
 * tokens.
 * ───────────────────────────────────────────────────────── */

const LEAD = "Iris screens every new application. ";
const PICKED =
  "Check integration experience and public evidence, then send the application to Maya for a decision.";
const REWRITE =
  "Check integration experience and public work. Send Maya the evidence and a recommendation.";

/* The passage: lead-in text, the selected `original`, and the streamed `rewrite`. */
export type SelectionText = {
  lead: string;
  original: string;
  rewrite: string;
};

/* A single AI action offered in the bar. Omit `action` for a no-op button
 * (e.g. Explain); `busyLabel` is the gerund shown while it runs. */
export type SelectionAction = {
  id: string;
  icon: ReactNode;
  action?: string;
  busyLabel?: string;
};

/* The action set: `primary` are always visible; `more` reveal on expand. */
export type SelectionActionSet = {
  primary: SelectionAction[];
  more: SelectionAction[];
};

/* Prominent copy strings. */
export type SelectionActionsLabels = {
  keep: string;
  discard: string;
  placeholder: string;
};

const DEFAULT_TEXT: SelectionText = {
  lead: LEAD,
  original: PICKED,
  rewrite: REWRITE,
};

const DEFAULT_LABELS: SelectionActionsLabels = {
  keep: "Keep",
  discard: "Discard",
  placeholder: "Describe edits",
};

type Mode = "idle" | "thinking" | "streaming" | "result";

const iconProps = {
  width: 14,
  height: 14,
  strokeWidth: 1.8,
  "aria-hidden": true,
} as const;

const icons = {
  explain: <ChatBubbleQuestion {...iconProps} />,
  improve: <Spark {...iconProps} />,
  shorten: <Scissor {...iconProps} />,
  tone: <EmojiSatisfied {...iconProps} />,
  grammar: <TextBox {...iconProps} />,
  send: (
    <ArrowUp
      width="16"
      height="16"
      strokeWidth="2.4"
      aria-hidden="true"
    />
  ),
  chevron: <NavArrowRight {...iconProps} />,
  check: <Check {...iconProps} />,
  close: <Xmark {...iconProps} />,
  retry: <Refresh {...iconProps} />,
};

/* the single "keep" affirm — solid ink with a hairline (not the atom's filled
 * highlight) shadow, so it stays a local one-off rather than a Button variant */
const primary =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink px-2.5 text-[12.5px] font-normal text-canvas shadow-hairline transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.96]";


const DEFAULT_ACTIONS: SelectionActionSet = {
  primary: [
    { id: "Explain", icon: icons.explain, action: "Explain", busyLabel: "Explaining" },
    { id: "Improve", icon: icons.improve, action: "Improve", busyLabel: "Improving" },
  ],
  more: [
    { id: "Shorten", icon: icons.shorten, action: "Shorten", busyLabel: "Shortening" },
    { id: "Tone", icon: icons.tone, action: "Change tone", busyLabel: "Changing tone" },
    { id: "Grammar", icon: icons.grammar, action: "Fix grammar" },
  ],
};

export type SelectionActionsProps = {
  /** Accepted for gallery/registry parity; not used by this bar. */
  variant?: string;
  /** The passage shown above the bar. */
  text?: Partial<SelectionText>;
  /** The AI actions offered in the bar. */
  actions?: SelectionActionSet;
  /** Prominent copy strings. */
  labels?: Partial<SelectionActionsLabels>;
  /** Called with the action name whenever an edit is run. */
  onAction?: (action: string) => void;
  /** Supply generated text in an embedding app. The default is the supplied demo rewrite. */
  onRequestEdit?: (action: string, original: string) => Promise<string>;
  onKeep?: (text: string) => void;
  onDiscard?: () => void;
  explanation?: string;
};

export default function SelectionActions({
  text: textProp,
  actions = DEFAULT_ACTIONS,
  labels,
  onAction,
  onRequestEdit,
  onKeep,
  onDiscard,
  explanation = "Iris gathers evidence. Maya decides whether the applicant joins the program.",
}: SelectionActionsProps = {}) {
  const reduce = useReducedMotion();
  const passage = { ...DEFAULT_TEXT, ...textProp };
  const [accepted, setAccepted] = useState<string | null>(null);
  const [resultText, setResultText] = useState(passage.rewrite);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const copy = { ...DEFAULT_LABELS, ...labels };
  const [shown, setShown] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");
  const [action, setAction] = useState("Improve");
  const [prompt, setPrompt] = useState("");
  const [typingWidth, setTypingWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const [positioned, setPositioned] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const previousModeRef = useRef<Mode>("idle");
  const lastWidthRef = useRef(0);
  const widthAnimationRef = useRef<Animation | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), 280);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (mode !== "thinking" || onRequestEdit) return;
    const timer = window.setTimeout(() => setMode("streaming"), 700);
    return () => window.clearTimeout(timer);
  }, [mode, onRequestEdit]);

  /* Attach beneath the final selected line, while centering the bar
   * against the complete selection bounds. requestAnimationFrame batches
   * streaming reflow measurements and avoids visible intermediate positions. */
  const place = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const host = hostRef.current;
      const selection = selectionRef.current;
      if (!host || !selection) return;

      const bounds = selection.getBoundingClientRect();
      const lines = Array.from(selection.getClientRects());
      const lastLine = lines.at(-1);
      if (!lastLine) return;

      const hostBounds = host.getBoundingClientRect();
      const barWidth = Math.min(barRef.current?.getBoundingClientRect().width ?? 0, hostBounds.width);
      const next = {
        x: Math.round(Math.max(barWidth / 2, Math.min(hostBounds.width - barWidth / 2, bounds.left - hostBounds.left + bounds.width / 2))),
        y: Math.round(lastLine.bottom - hostBounds.top + 8),
      };

      setAnchor((current) =>
        current.x === next.x && current.y === next.y ? current : next,
      );
      setPositioned(true);
    });
  }, []);

  useLayoutEffect(() => {
    place();
  }, [mode, place]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(place);
    observer.observe(host);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [place]);

  /* Intrinsic width handles the preset expansion. When the entire content
   * changes between idle, loading and confirmation, animate from the last
   * rendered width to the new intrinsic width before the browser paints. */
  useLayoutEffect(() => {
    const bar = barRef.current;
    const content = contentRef.current;
    if (!bar || !content) return;

    const nextWidth = Math.ceil(content.getBoundingClientRect().width) + 8;
    const previousWidth =
      lastWidthRef.current || Math.ceil(bar.getBoundingClientRect().width);

    if (
      !reduce && previousModeRef.current !== mode &&
      Math.abs(nextWidth - previousWidth) > 1
    ) {
      widthAnimationRef.current?.cancel();
      const animation = bar.animate(
        [
          { width: `${previousWidth}px` },
          { width: `${nextWidth}px` },
        ],
        {
          duration: 320,
          easing: "cubic-bezier(0.23,1,0.32,1)",
        },
      );
      widthAnimationRef.current = animation;
      animation.onfinish = () => {
        lastWidthRef.current = nextWidth;
        widthAnimationRef.current = null;
      };
    } else {
      lastWidthRef.current = nextWidth;
    }

    previousModeRef.current = mode;
  }, [mode, reduce]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (widthAnimationRef.current?.playState === "running") return;
      lastWidthRef.current =
        Math.ceil(content.getBoundingClientRect().width) + 8;
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      widthAnimationRef.current?.cancel();
    };
  }, []);

  useEffect(() => () => { requestVersion.current += 1; }, []);
  const run = async (nextAction: string) => {
    const version = ++requestVersion.current;
    setAction(nextAction); setError(""); setExpanded(false);
    setResultText(nextAction === "Explain" ? explanation : passage.rewrite);
    setMode("thinking");
    onAction?.(nextAction);
    if (!onRequestEdit) return;
    try {
      const result = await onRequestEdit(nextAction, accepted ?? passage.original);
      if (version === requestVersion.current) { setResultText(result); setMode("streaming"); }
    } catch {
      if (version === requestVersion.current) { setMode("idle"); setError("Couldn't apply the edit. Try again."); }
    }
  };

  const reset = () => {
    requestVersion.current += 1;
    setExpanded(false);
    setPrompt("");
    setTypingWidth(null);
    setAction("Improve");
    setMode("idle");
  };

  const keep = () => { if (action !== "Explain") { setAccepted(resultText); onKeep?.(resultText); } reset(); };
  const discard = () => { onDiscard?.(); reset(); };

  const busy = mode === "thinking" || mode === "streaming";
  const visible = shown && positioned;
  const hasPrompt = prompt.trim().length > 0;
  const busyLabelMap: Record<string, string> = {};
  for (const item of [...actions.primary, ...actions.more]) {
    if (item.action && item.busyLabel) busyLabelMap[item.action] = item.busyLabel;
  }
  const busyLabel = busyLabelMap[action] ?? "Editing";

  return (
    <div className="w-full max-w-[460px]">
      <div ref={hostRef} className="relative pb-12">
        <p className="text-[13px] leading-relaxed text-ink">
          {passage.lead}
          <span
            ref={selectionRef}
            tabIndex={0}
            role="button"
            aria-label="Edit selected passage"
            onClick={() => setShown(true)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setShown(true); } }}
            className="box-decoration-clone rounded-[3px] bg-[color-mix(in_srgb,var(--accent)_14%,var(--surface))] text-ink dark:bg-accent-tint"
          >
            {mode === "idle" || mode === "thinking" || action === "Explain" ? (
              accepted ?? passage.original
            ) : mode === "streaming" ? (
              <StreamText
                text={resultText}
                onProgress={place}
                onDone={() => setMode("result")}
              />
            ) : (
              resultText
            )}
          </span>
        </p>

        {action === "Explain" && (mode === "streaming" || mode === "result") && <p className="mt-14 rounded-control bg-field p-3 text-[13px] text-ink-2" role="status">{mode === "streaming" ? <StreamText text={resultText} onDone={() => setMode("result")} /> : resultText}</p>}
        {error && <p className="mt-2 text-[12px] text-red" role="alert">{error}</p>}
        <div
          className="absolute top-0 left-0 z-10"
          style={{
            transform: `translate3d(${anchor.x}px, ${anchor.y}px, 0) translateX(-50%)`,
            transition:
              "transform 320ms cubic-bezier(0.77,0,0.175,1), opacity 180ms ease-out",
            opacity: visible ? 1 : 0,
            pointerEvents: visible ? "auto" : "none",
            willChange: "transform",
          }}
        >
          {/* A 36px pill wraps 28px controls at a 4px inset. The controls
              resolve to a 14px radius, preserving the concentric curve. */}
          <div
            ref={barRef}
            className="selection-toolbar flex h-10 w-fit max-w-[min(460px,calc(100vw-64px))] items-center gap-0.5 overflow-x-auto overflow-y-hidden rounded-full bg-surface p-1 font-sans font-normal text-ink shadow-overlay"
            style={{
              width:
                mode === "idle" && hasPrompt && typingWidth
                  ? typingWidth
                  : undefined,
              ...(visible
                ? {
                    animation:
                      "pop-in 220ms cubic-bezier(0.23,1,0.32,1) both",
                  }
                : {}),
            }}
          >
            <div
              ref={contentRef}
              className="flex w-fit shrink-0 items-center justify-center gap-0.5"
              style={{
                width:
                  mode === "idle" && hasPrompt && typingWidth
                    ? typingWidth - 8
                    : undefined,
              }}
            >
            {busy && (
              <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap px-2.5 text-[12.5px] font-normal text-ink-2">
                <span
                  className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
                  style={{ animation: reduce ? "none" : "spin 700ms linear infinite" }}
                />
                {mode === "thinking" ? (
                  <Shimmer className="text-[12.5px] font-normal">
                    {busyLabel}…
                  </Shimmer>
                ) : (
                  <span>{busyLabel}…</span>
                )}
              </span>
            )}

            {mode === "result" && (
              <>
                <button
                  type="button"
                  onClick={keep}
                  className={primary}
                >
                  {icons.check}
                  {action === "Explain" ? "Done" : copy.keep}
                </button>
                <Button type="button" variant="quiet" size="xs" className="shrink-0" onClick={discard}>
                  {icons.close}
                  {copy.discard}
                </Button>
                <span className="mx-0.5 h-4 w-px shrink-0 bg-line" />
                <button
                  type="button"
                  aria-label="Try again"
                  onClick={() => run(action)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink-2 active:scale-[0.96]"
                >
                  {icons.retry}
                </button>
              </>
            )}

            {mode === "idle" && (
              <>
                <div
                  className="flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-400"
                  style={{
                    maxWidth: expanded
                      ? 0
                      : hasPrompt && typingWidth
                        ? typingWidth - 40
                        : 145,
                    opacity: expanded ? 0 : 1,
                    transform: expanded ? "translateX(-8px)" : "translateX(0)",
                    transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                  }}
                >
                  <form
                    inert={expanded}
                    className="flex h-7 shrink-0 items-center transition-[width] duration-400"
                    style={{
                      width:
                        hasPrompt && typingWidth ? typingWidth - 40 : 145,
                      transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                    }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(prompt.trim() || "Improve");
                    }}
                  >
                    <input
                      value={prompt}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (!prompt.trim() && next.trim()) {
                          setTypingWidth(
                            Math.ceil(
                              barRef.current?.getBoundingClientRect().width ??
                                0,
                            ),
                          );
                        } else if (!next.trim()) {
                          setTypingWidth(null);
                        }
                        setPrompt(next);
                      }}
                      aria-label={copy.placeholder}
                      placeholder={copy.placeholder}
                      className="h-7 w-full bg-transparent pr-2.5 pl-3 text-[12.5px] text-ink placeholder:text-ink-3"
                    />
                  </form>
                </div>

                <div
                  inert={hasPrompt}
                  className="flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity,transform] duration-400"
                  style={{
                    maxWidth: hasPrompt ? 0 : expanded ? 600 : 260,
                    opacity: hasPrompt ? 0 : 1,
                    transform: hasPrompt ? "translateX(-8px)" : "translateX(0)",
                    transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                  }}
                >
                  {!expanded && (
                    <span className="mx-1 h-4 w-px shrink-0 bg-line-strong" />
                  )}
                  {actions.primary.map((item) => (
                    <Button
                      key={item.id}
                      type="button"
                      variant="quiet"
                      size="xs"
                      className="shrink-0"
                      onClick={item.action ? () => run(item.action!) : undefined}
                    >
                      {item.icon}
                      {item.id}
                    </Button>
                  ))}

                  <div
                    inert={!expanded}
                    className="flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity,margin] duration-400"
                    style={{
                      maxWidth: expanded ? 262 : 0,
                      opacity: expanded ? 1 : 0,
                      marginLeft: expanded ? 2 : 0,
                      transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                    }}
                  >
                  {actions.more.map((item) => (
                    <Button
                      key={item.id}
                      type="button"
                      variant="quiet"
                      size="xs"
                      className="shrink-0"
                      onClick={item.action ? () => run(item.action!) : undefined}
                    >
                      {item.icon}
                      {item.id}
                    </Button>
                  ))}
                  </div>

                  <span className="mx-0.5 h-4 w-px shrink-0 bg-line" />
                  <button
                    type="button"
                    aria-label={expanded ? "Show fewer actions" : "Show more actions"}
                    aria-expanded={expanded}
                    onClick={() => setExpanded((value) => !value)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink transition-[background-color,transform] duration-200 hover:bg-hover active:scale-[0.96]"
                  >
                    <span
                      className="flex transition-transform duration-400"
                      style={{
                        transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                        transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                      }}
                    >
                      {icons.chevron}
                    </span>
                  </button>
                </div>

                <div
                  inert={!hasPrompt}
                  className="flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-400"
                  style={{
                    maxWidth: hasPrompt ? 30 : 0,
                    opacity: hasPrompt ? 1 : 0,
                    transform: hasPrompt ? "scale(1)" : "scale(0.88)",
                    transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                  }}
                >
                  <button
                    type="button"
                    aria-label="Send edit instruction"
                    onClick={() => run(prompt.trim())}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-surface transition-[opacity,transform] duration-200 active:scale-[0.94]"
                  >
                    {icons.send}
                  </button>
                </div>
              </>
            )}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
