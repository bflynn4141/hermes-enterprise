/*! Adapted from Beautiful UI, Copyright (c) 2026 Shane Levine. MIT. See LICENSE.beautiful-ui. */

// src/components/primitives/LoadingState.tsx
import { useEffect as useEffect3, useRef as useRef2, useState as useState3 } from "react";

// src/lib/motion.tsx
import { createContext, useContext, useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import { jsx } from "react/jsx-runtime";
var MotionPreference = createContext(false);
function useReducedMotion() {
  const override = useContext(MotionPreference);
  const [system, setSystem] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setSystem(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return override || system;
}
function HermesMotionProvider({ reducedMotion = false, children }) {
  return /* @__PURE__ */ jsx(MotionPreference.Provider, { value: reducedMotion, children: /* @__PURE__ */ jsx(MotionBoundary, { children }) });
}
function MotionBoundary({ children }) {
  const reduce = useReducedMotion();
  return /* @__PURE__ */ jsx(MotionConfig, { reducedMotion: reduce ? "always" : "user", children: /* @__PURE__ */ jsx("div", { className: "hermes-ui", "data-reduced-motion": reduce, children }) });
}

// src/components/primitives/AgentScreen.tsx
import { useEffect as useEffect2, useRef, useState as useState2 } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";

// src/components/atoms/Button.tsx
import { cva } from "class-variance-authority";

// src/lib/utils.ts
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// src/components/atoms/Button.tsx
import { jsx as jsx2 } from "react/jsx-runtime";
var filledShadow = "shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]";
var buttonVariants = cva(
  `inline-flex items-center justify-center font-medium select-none
   transition-[transform,background-color,opacity] duration-150 ease-out
   active:scale-[0.96] disabled:opacity-50 disabled:pointer-events-none`,
  {
    variants: {
      variant: {
        primary: `bg-accent text-white hover:opacity-90 ${filledShadow}`,
        secondary: "bg-surface text-ink shadow-btn hover:bg-inset aria-expanded:bg-hover",
        ghost: "bg-hover-2 text-ink hover:bg-line-strong",
        accent: `bg-accent text-white hover:bg-accent-ink ${filledShadow}`,
        success: `bg-green text-white hover:brightness-95 ${filledShadow}`,
        /* transparent until hovered — for dense toolbars/action rows */
        quiet: "text-ink hover:bg-hover"
      },
      size: {
        /* compact toolbar pill — fixed height, lighter weight */
        xs: "h-8 rounded-[8px] px-2.5 text-[12px] font-normal leading-none gap-1",
        /* canonical action pill — 27px tall, roomy sides */
        sm: "h-[34px] px-3 text-[13px] leading-none rounded-[8px] gap-1.5",
        md: "px-4 py-[9px] text-sm leading-none rounded-[8px] gap-2"
      }
    },
    defaultVariants: { variant: "secondary", size: "md" }
  }
);
function Button({
  variant,
  size,
  className,
  ...props
}) {
  return /* @__PURE__ */ jsx2("button", { className: cn(buttonVariants({ variant, size }), className), ...props });
}

// src/components/primitives/AgentScreen.tsx
import { jsx as jsx3, jsxs } from "react/jsx-runtime";
function HermesConnectionMark() {
  return /* @__PURE__ */ jsxs("svg", { viewBox: "0 0 48 48", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx3("defs", { children: /* @__PURE__ */ jsxs("linearGradient", { id: "hermes-connection-glass", x1: "8", y1: "7", x2: "40", y2: "42", gradientUnits: "userSpaceOnUse", children: [
      /* @__PURE__ */ jsx3("stop", { stopColor: "#fff" }),
      /* @__PURE__ */ jsx3("stop", { offset: ".52", stopColor: "#d7d3f4" }),
      /* @__PURE__ */ jsx3("stop", { offset: "1", stopColor: "#827bde" })
    ] }) }),
    /* @__PURE__ */ jsx3("path", { d: "M24 5c4.8 0 7.7 5.7 5.1 9.8 4.6-2.1 9.9 1.2 9.9 6.2s-5.3 8.3-9.9 6.2c2.6 4.1-.3 9.8-5.1 9.8s-7.7-5.7-5.1-9.8C14.3 29.3 9 26 9 21s5.3-8.3 9.9-6.2C16.3 10.7 19.2 5 24 5Z", fill: "url(#hermes-connection-glass)" }),
    /* @__PURE__ */ jsx3("circle", { cx: "24", cy: "21", r: "4.5", fill: "#1a135d" }),
    /* @__PURE__ */ jsx3("path", { d: "M20.8 21h6.4M24 17.8v6.4", stroke: "#f6f4ff", strokeWidth: "1.4", strokeLinecap: "round" })
  ] });
}
function IrisConnectionMark() {
  return /* @__PURE__ */ jsxs("svg", { viewBox: "0 0 64 64", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx3("defs", { children: /* @__PURE__ */ jsxs("linearGradient", { id: "iris-connection-glass", x1: "10", y1: "7", x2: "49", y2: "60", gradientUnits: "userSpaceOnUse", children: [
      /* @__PURE__ */ jsx3("stop", { stopColor: "#fff" }),
      /* @__PURE__ */ jsx3("stop", { offset: ".45", stopColor: "#e9e6f6" }),
      /* @__PURE__ */ jsx3("stop", { offset: ".72", stopColor: "#bdb7d8" }),
      /* @__PURE__ */ jsx3("stop", { offset: "1", stopColor: "#716b96" })
    ] }) }),
    /* @__PURE__ */ jsx3("path", { d: "M32 9c6 0 10 8 6 15 7-4 15 0 15 7s-8 11-15 7c4 7 0 15-7 15s-11-8-7-15c-7 4-15 0-15-7s8-11 15-7c-4-7 0-15 8-15Z", fill: "url(#iris-connection-glass)" }),
    /* @__PURE__ */ jsx3("path", { d: "M32 10c4 0 8 5 7 11l-7 9-7-7c-3-6 0-13 7-13Z", fill: "#fff", opacity: ".72" }),
    /* @__PURE__ */ jsx3("path", { d: "m33 32 15-6c7 8-2 16-9 12l-5 11-6-11Z", fill: "#9e9abf", opacity: ".38" }),
    /* @__PURE__ */ jsx3("circle", { cx: "31", cy: "31", r: "6", fill: "#26214c" }),
    /* @__PURE__ */ jsx3("circle", { cx: "31", cy: "30", r: "5", fill: "#181333" })
  ] });
}
function AgentConnection({ agentName, reduce }) {
  const repeat = reduce ? 0 : Infinity;
  return /* @__PURE__ */ jsxs("div", { className: "agent-connection", role: "status", "aria-label": `Connecting to ${agentName}`, children: [
    /* @__PURE__ */ jsxs("div", { className: "agent-connection-visual", "aria-hidden": "true", children: [
      /* @__PURE__ */ jsx3(motion.span, { className: "agent-connection-node", initial: reduce ? false : { opacity: 0, scale: 0.9, y: 5 }, animate: { opacity: 1, scale: 1, y: 0 }, transition: { duration: reduce ? 0 : 0.32, ease: [0.23, 1, 0.32, 1] }, children: /* @__PURE__ */ jsx3(HermesConnectionMark, {}) }),
      /* @__PURE__ */ jsxs("span", { className: "agent-connection-rail", children: [
        /* @__PURE__ */ jsx3(motion.span, { className: "agent-connection-line", initial: reduce ? false : { scaleX: 0 }, animate: { scaleX: 1 }, transition: { duration: reduce ? 0 : 0.55, delay: reduce ? 0 : 0.18, ease: [0.23, 1, 0.32, 1] } }),
        !reduce && /* @__PURE__ */ jsx3(motion.span, { className: "agent-connection-signal", initial: { left: "0%", opacity: 0 }, animate: { left: ["0%", "50%", "100%"], opacity: [0, 1, 0], scale: [0.7, 1.15, 0.7] }, transition: { duration: 1.55, delay: 0.55, repeat, ease: "easeInOut", repeatDelay: 0.28 } })
      ] }),
      /* @__PURE__ */ jsxs(motion.span, { className: "agent-connection-node agent-connection-node-iris", initial: reduce ? false : { opacity: 0, scale: 0.86, y: 5 }, animate: { opacity: 1, scale: 1, y: 0 }, transition: { duration: reduce ? 0 : 0.36, delay: reduce ? 0 : 0.28, ease: [0.23, 1, 0.32, 1] }, children: [
        /* @__PURE__ */ jsx3("span", { className: "agent-connection-orbit" }),
        /* @__PURE__ */ jsx3(motion.span, { className: "agent-connection-iris-glyph", animate: reduce ? { scale: 1 } : { scale: [1, 1.045, 1] }, transition: { duration: 2.4, delay: 0.7, ease: "easeInOut", repeat, repeatDelay: 0.15 }, children: /* @__PURE__ */ jsx3(IrisConnectionMark, {}) })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "agent-connection-status", children: [
      /* @__PURE__ */ jsx3(motion.span, { className: "agent-connection-dot", animate: reduce ? { opacity: 1 } : { opacity: [0.45, 1, 0.45] }, transition: { duration: 1.4, repeat, ease: "easeInOut" } }),
      /* @__PURE__ */ jsxs("span", { children: [
        "Connecting to ",
        agentName
      ] })
    ] })
  ] });
}
function PartnerWorkspacePreview() {
  return /* @__PURE__ */ jsxs("div", { className: "agent-preview", children: [
    /* @__PURE__ */ jsxs("div", { className: "agent-preview-head", children: [
      /* @__PURE__ */ jsx3("span", { children: "Hermes" }),
      /* @__PURE__ */ jsx3("span", { style: { marginLeft: "auto", color: "var(--ink-2)" }, children: "Partner program" })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "agent-preview-grid", children: [
      /* @__PURE__ */ jsxs("div", { className: "agent-preview-nav", children: [
        /* @__PURE__ */ jsx3("span", { children: "Agents" }),
        /* @__PURE__ */ jsx3("span", { style: { color: "var(--ink)" }, children: "Inbox\u30004" }),
        /* @__PURE__ */ jsx3("span", { children: "Members" }),
        /* @__PURE__ */ jsx3("span", { children: "Shared skills" }),
        /* @__PURE__ */ jsx3("span", { children: "Settings" })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "agent-preview-content", children: [
        /* @__PURE__ */ jsx3("h3", { children: "Needs your review" }),
        [["Owen", "Partner application", "Review"], ["Leah", "Partner application", "Review"], ["Robin Studio", "Services agreement", "Sign"], ["Robin Studio", "Invoice \xB7 $1,200", "Pay"]].map(([name, desc, action]) => /* @__PURE__ */ jsxs("div", { className: "agent-preview-row", children: [
          /* @__PURE__ */ jsx3("span", { style: { fontSize: 18, color: "var(--ink-2)" }, children: "\u25C7" }),
          /* @__PURE__ */ jsxs("div", { children: [
            name,
            /* @__PURE__ */ jsx3("small", { children: desc })
          ] }),
          /* @__PURE__ */ jsx3("span", { className: "agent-preview-count", children: action })
        ] }, name + desc))
      ] })
    ] })
  ] });
}
function AgentScreen({ agentName = "Iris", streamSrc, variant = "Working", children, onCaptureStart, onCaptureEnd, onOpenChange } = {}) {
  const reduce = useReducedMotion();
  const loading = variant === "Loading";
  const [open, setOpen] = useState2(false);
  const [recording, setRecording] = useState2(false);
  const [secs, setSecs] = useState2(0);
  const [saved, setSaved] = useState2(false);
  const opener = useRef(null);
  const dialog = useRef(null);
  const close = () => {
    setOpen(false);
    onOpenChange?.(false);
  };
  useEffect2(() => {
    if (!recording) return;
    const start = Date.now();
    const timer = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1e3)), 250);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect2(() => {
    if (!open) return;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    const key = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab") {
        const els = Array.from(dialog.current?.querySelectorAll('button:not([disabled]),a[href],input,[tabindex="0"]') || []);
        if (!els.length) {
          e.preventDefault();
          return;
        }
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", key);
      (previous || opener.current)?.focus();
    };
  }, [open]);
  const capture = () => {
    if (recording) {
      setRecording(false);
      setSaved(true);
      onCaptureEnd?.(secs);
    } else {
      setSaved(false);
      setSecs(0);
      setRecording(true);
      onCaptureStart?.();
    }
  };
  const preview = streamSrc ? /\.(mp4|webm)(\?|$)/i.test(streamSrc) ? /* @__PURE__ */ jsx3("video", { src: streamSrc, autoPlay: !reduce, muted: true, loop: !reduce, controls: reduce, playsInline: true, style: { width: "100%", maxHeight: "70vh", objectFit: "contain" } }) : /* @__PURE__ */ jsx3("img", { src: streamSrc, alt: `${agentName}'s workspace`, style: { width: "100%", maxHeight: "70vh", objectFit: "contain" } }) : children || /* @__PURE__ */ jsx3(PartnerWorkspacePreview, {});
  return /* @__PURE__ */ jsxs("div", { className: "w-full max-w-[680px]", children: [
    /* @__PURE__ */ jsx3(motion.div, { initial: reduce ? false : { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.38, ease: [0.23, 1, 0.32, 1] }, children: loading ? /* @__PURE__ */ jsx3("div", { className: "agent-preview agent-preview-loading", children: /* @__PURE__ */ jsx3(AgentConnection, { agentName, reduce }) }) : /* @__PURE__ */ jsxs("button", { ref: opener, type: "button", "aria-label": `Open ${agentName}'s screen`, className: "agent-window-open", onClick: () => {
      setOpen(true);
      onOpenChange?.(true);
    }, children: [
      preview,
      /* @__PURE__ */ jsx3("span", { className: "open-label", children: "Open screen \u2197" })
    ] }) }),
    /* @__PURE__ */ jsxs("div", { className: "mt-4 flex items-center gap-3 text-sm", children: [
      /* @__PURE__ */ jsxs("span", { children: [
        agentName,
        "\u2019s workspace"
      ] }),
      recording ? /* @__PURE__ */ jsxs("span", { className: "ml-auto text-red", role: "status", children: [
        "\u25CF Demo capture \xB7 ",
        secs,
        "s"
      ] }) : /* @__PURE__ */ jsx3("span", { className: "ml-auto text-ink-3", children: saved ? "Example captured locally" : "Preview" })
    ] }),
    typeof document !== "undefined" && createPortal(/* @__PURE__ */ jsx3(AnimatePresence, { children: open && /* @__PURE__ */ jsxs(motion.div, { className: "hermes-ui fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6", "data-reduced-motion": reduce, initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: reduce ? 0 : 0.18 }, children: [
      /* @__PURE__ */ jsx3("div", { className: "absolute inset-0 bg-black/70", onClick: close }),
      /* @__PURE__ */ jsxs(motion.div, { ref: dialog, role: "dialog", "aria-modal": "true", "aria-label": `${agentName}'s screen`, tabIndex: -1, initial: reduce ? false : { scale: 0.95 }, animate: { scale: 1 }, exit: { scale: reduce ? 1 : 0.97 }, transition: { duration: reduce ? 0 : 0.24, ease: [0.23, 1, 0.32, 1] }, className: "relative w-full max-w-[960px] overflow-hidden rounded-[16px] bg-surface p-3 shadow-overlay", children: [
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 pb-3", children: [
          /* @__PURE__ */ jsx3("strong", { className: "font-medium", children: agentName }),
          recording && /* @__PURE__ */ jsxs("span", { className: "text-sm text-red", children: [
            "\u25CF Demo capture \xB7 ",
            secs,
            "s"
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "ml-auto flex items-center gap-2", children: [
            /* @__PURE__ */ jsx3(Button, { onClick: capture, size: "sm", children: recording ? "End capture" : "Teach a loop" }),
            /* @__PURE__ */ jsx3(Button, { "aria-label": "Close screen", onClick: close, size: "sm", children: "\u2715" })
          ] })
        ] }),
        /* @__PURE__ */ jsx3("div", { style: { maxHeight: "72vh", overflow: "auto" }, children: preview }),
        /* @__PURE__ */ jsx3("p", { className: "pt-3 text-sm text-ink-2", children: recording ? "Demonstrate the steps. Capture is simulated in this showcase." : saved ? "Captured example is ready to attach to a skill." : "Read-only preview \xB7 no actions run" })
      ] })
    ] }, "viewer") }), document.body)
  ] });
}

// src/components/primitives/LoadingState.tsx
import { Fragment, jsx as jsx4, jsxs as jsxs2 } from "react/jsx-runtime";
var chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});
var ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
var orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});
var PATTERNS = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false }
};
function LoaderGrid({
  delays,
  dur,
  round
}) {
  return /* @__PURE__ */ jsx4("span", { "aria-hidden": true, "data-loader-grid": true, className: "grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]", children: delays.map((delay, index) => /* @__PURE__ */ jsx4(
    "span",
    {
      className: `size-[4px] bg-ink ${round ? "rounded-full" : "rounded-[1px]"}`,
      style: {
        opacity: delay === null ? 0.07 : 0.15,
        animation: delay === null ? "none" : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`
      }
    },
    index
  )) });
}
function useElapsed(active) {
  const [ds, setDs] = useState3(0);
  const accumulated = useRef2(0);
  useEffect3(() => {
    if (!active) return;
    const start = Date.now();
    const t = setInterval(() => setDs(Math.floor((accumulated.current + Date.now() - start) / 100)), 100);
    return () => {
      accumulated.current += Date.now() - start;
      clearInterval(t);
    };
  }, [active]);
  const total = ds / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}
function LoadingState({
  label,
  variant = "Drive",
  /** Optional media for the Context variant; otherwise use a supplied context node. */
  videoSrc,
  context,
  active = true
}) {
  const reduce = useReducedMotion();
  const elapsed = useElapsed(active);
  const surfer = variant === "Surfer" || variant === "Context";
  const resolvedLabel = label ?? (active ? "Reviewing partner criteria" : "Paused");
  const [videoOk, setVideoOk] = useState3(true);
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.Drive;
  const labelEl = /* @__PURE__ */ jsx4(
    "span",
    {
      "data-loader-label": true,
      className: "bg-clip-text text-[13px] font-medium text-transparent",
      style: {
        backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
        backgroundSize: "200% 100%",
        animation: active && !reduce ? "shimmer-text 1.4s linear infinite" : "none"
      },
      children: resolvedLabel
    }
  );
  const elapsedEl = /* @__PURE__ */ jsx4("span", { className: "font-mono text-[12px] text-ink-3 tabular-nums", children: elapsed });
  if (surfer) {
    return /* @__PURE__ */ jsxs2("div", { role: "status", "data-active": active, className: "flex w-fit flex-col items-start", style: { animationPlayState: active ? "running" : "paused" }, children: [
      /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-2.5", children: [
        /* @__PURE__ */ jsx4(LoaderGrid, { ...PATTERNS.Drive }),
        labelEl,
        elapsedEl
      ] }),
      /* @__PURE__ */ jsx4(
        "div",
        {
          className: "mt-3 w-full max-w-[420px] overflow-hidden rounded-[10px] shadow-overlay",
          style: { animation: "pop-in 200ms cubic-bezier(0.16,1,0.3,1) both", transformOrigin: "top left" },
          children: /* @__PURE__ */ jsx4("div", { className: "relative w-full", style: { background: "var(--tooltip-bg)" }, children: videoSrc && videoOk ? /* @__PURE__ */ jsx4(
            "video",
            {
              src: videoSrc,
              autoPlay: !reduce && active,
              muted: true,
              loop: !reduce,
              playsInline: true,
              onError: () => setVideoOk(false),
              className: "h-full w-full object-cover"
            }
          ) : /* @__PURE__ */ jsx4(Fragment, { children: context || /* @__PURE__ */ jsx4(PartnerWorkspacePreview, {}) }) })
        }
      )
    ] });
  }
  return /* @__PURE__ */ jsxs2("div", { role: "status", "data-active": active, className: "flex w-fit items-center gap-2.5", children: [
    /* @__PURE__ */ jsx4(LoaderGrid, { delays, dur, round }),
    labelEl,
    elapsedEl
  ] });
}

// src/components/primitives/ThinkingState.tsx
import { useEffect as useEffect4, useLayoutEffect, useRef as useRef3, useState as useState4 } from "react";
import { Fragment as Fragment2, jsx as jsx5, jsxs as jsxs3 } from "react/jsx-runtime";
var STAGES = [800, 600, 1800, 2600, 1600];
function useSequence(steps, reducedMotion) {
  const [stage, setStage] = useState4(0);
  useEffect4(() => {
    if (reducedMotion || stage >= steps.length - 1) return;
    const t = setTimeout(() => setStage((s) => s + 1), steps[stage]);
    return () => clearTimeout(t);
  }, [stage, steps, reducedMotion]);
  return reducedMotion ? steps.length - 1 : stage;
}
var VARIANTS = {
  Steps: {
    active: "Checking applications",
    done: "Review ready",
    rows: [
      { primary: "Reading partner criteria" },
      { primary: "Checking application evidence" },
      { primary: "Preparing review summaries", secondary: "2 applications" },
      { primary: "Saving drafts for Maya" }
    ]
  },
  Reasoning: {
    active: "Checking applications",
    done: "Review ready",
    rows: [
      { primary: "Both applications include integration examples." },
      { primary: "Admission needs Maya\u2019s review. Access stays pending." }
    ]
  },
  Search: {
    active: "Searching the web",
    done: "Searched the web",
    query: "Hermes integration partners",
    rows: [
      { primary: "Hermes Agent", secondary: "github.com/NousResearch", href: "https://github.com/NousResearch/hermes-agent" },
      { primary: "Nous Research", secondary: "nousresearch.com", href: "https://nousresearch.com/" },
      { primary: "Hermes documentation", secondary: "hermes-agent.nousresearch.com", href: "https://hermes-agent.nousresearch.com/" }
    ]
  },
  Coding: {
    active: "Running tools",
    done: "Ran 3 tools",
    rows: [
      { primary: "Read", secondary: "partner-criteria.md", mono: true },
      { primary: "Edit", secondary: "screen-applications.ts", mono: true, add: 74, del: 41 },
      { primary: "Run", secondary: "npm run verify", mono: true }
    ]
  }
};
function Dot({ tone }) {
  return /* @__PURE__ */ jsx5("span", { className: `flex size-3.5 shrink-0 items-center justify-center rounded-full text-white ${tone}`, children: /* @__PURE__ */ jsxs3("svg", { width: "9", height: "9", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", children: [
    /* @__PURE__ */ jsx5("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ jsx5("path", { d: "M3.5 12h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" })
  ] }) });
}
var TONES = ["bg-accent", "bg-orange", "bg-green"];
function ThinkingState({
  variant = "Steps",
  onSettled,
  rows,
  active,
  done,
  icon,
  query,
  additionalSources = 0,
  stage: controlledStage
}) {
  const reducedMotion = useReducedMotion();
  const automaticStage = useSequence(STAGES, reducedMotion);
  const stage = controlledStage === void 0 ? automaticStage : Math.max(0, Math.min(4, controlledStage));
  const [manualExpanded, setManualExpanded] = useState4(null);
  const [selectedTool, setSelectedTool] = useState4(null);
  const base = VARIANTS[variant] ?? VARIANTS.Steps;
  const v = {
    ...base,
    rows: rows ?? base.rows,
    active: active ?? base.active,
    done: done ?? base.done,
    query: query ?? base.query
  };
  const autoExpanded = stage >= 1 && stage < 4;
  const expanded = manualExpanded ?? autoExpanded;
  const working = stage < 3;
  const visible = stage < 2 ? 0 : stage === 2 ? Math.min(2, v.rows.length) : v.rows.length;
  const traceRef = useRef3(null);
  const [lineHeight, setLineHeight] = useState4(0);
  useLayoutEffect(() => {
    if (traceRef.current) setLineHeight(traceRef.current.offsetHeight);
  }, [visible, expanded, variant, stage]);
  const settledRef = useRef3(false);
  useEffect4(() => {
    if (working) {
      settledRef.current = false;
      return;
    }
    if (settledRef.current) return;
    settledRef.current = true;
    onSettled?.();
  }, [working, onSettled]);
  return /* @__PURE__ */ jsxs3(
    "div",
    {
      "data-reduced-motion": reducedMotion || void 0,
      className: "flex w-full max-w-95 flex-col",
      style: {
        minHeight: working || expanded ? 176 : void 0,
        transition: reducedMotion ? "none" : "min-height 400ms cubic-bezier(0.23,1,0.32,1)"
      },
      children: [
        /* @__PURE__ */ jsxs3(
          "button",
          {
            type: "button",
            "aria-expanded": expanded,
            onClick: () => setManualExpanded((current) => !(current ?? autoExpanded)),
            className: "-mx-1.5 flex w-fit items-center gap-2 rounded-control px-1.5 py-1\n          transition-colors duration-100 hover:bg-hover-2",
            children: [
              icon ? /* @__PURE__ */ jsx5("span", { className: "flex shrink-0 transition-colors duration-200", style: { color: working ? "var(--ink-2)" : "var(--ink-3)" }, children: icon }) : /* @__PURE__ */ jsx5("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: working ? "var(--ink-2)" : "var(--ink-3)", children: /* @__PURE__ */ jsx5("path", { d: "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" }) }),
              /* @__PURE__ */ jsx5("span", { role: "status", className: "contents", children: working ? /* @__PURE__ */ jsx5(
                "span",
                {
                  className: "bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent",
                  style: {
                    backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
                    backgroundSize: "200% 100%",
                    animation: reducedMotion ? "none" : "shimmer-text 1.4s linear infinite"
                  },
                  children: v.active
                }
              ) : /* @__PURE__ */ jsx5(
                "span",
                {
                  className: "text-[13px] font-medium whitespace-nowrap text-ink-2",
                  style: { animation: "fade-in 350ms ease-out both" },
                  children: v.done
                }
              ) }),
              /* @__PURE__ */ jsx5(
                "svg",
                {
                  width: "14",
                  height: "14",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "var(--ink-3)",
                  strokeWidth: "2.2",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  className: "transition-transform duration-300",
                  style: { transform: expanded ? "rotate(180deg)" : "rotate(0)" },
                  children: /* @__PURE__ */ jsx5("path", { d: "M6 9l6 6 6-6" })
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ jsx5(
          "div",
          {
            inert: !expanded,
            className: "grid transition-[grid-template-rows,opacity] duration-400",
            style: {
              gridTemplateRows: expanded ? "1fr" : "0fr",
              opacity: expanded ? 1 : 0,
              transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)"
            },
            children: /* @__PURE__ */ jsx5("div", { className: "overflow-hidden", children: /* @__PURE__ */ jsxs3("div", { className: "relative mt-1 ml-[5px] pl-4", children: [
              /* @__PURE__ */ jsx5(
                "span",
                {
                  "aria-hidden": true,
                  className: "absolute left-[3px] w-px bg-line",
                  style: { top: -8, height: lineHeight ? lineHeight - 2 : 0, transition: "height 500ms cubic-bezier(0.23,1,0.32,1)" }
                }
              ),
              /* @__PURE__ */ jsxs3("div", { ref: traceRef, className: "flex flex-col gap-1 py-1", children: [
                v.query && /* @__PURE__ */ jsxs3("div", { className: "flex h-6 items-center gap-2 px-1.5", style: { animation: expanded ? "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" : void 0 }, children: [
                  /* @__PURE__ */ jsxs3("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "var(--ink-3)", strokeWidth: "2", strokeLinecap: "round", className: "shrink-0", children: [
                    /* @__PURE__ */ jsx5("circle", { cx: "11", cy: "11", r: "7" }),
                    /* @__PURE__ */ jsx5("path", { d: "M21 21l-4.3-4.3" })
                  ] }),
                  /* @__PURE__ */ jsx5("span", { className: "text-[12.5px] text-ink-2", children: v.query })
                ] }),
                v.rows.slice(0, visible).map((row, i) => {
                  const content = /* @__PURE__ */ jsxs3(Fragment2, { children: [
                    variant === "Search" && /* @__PURE__ */ jsx5(Dot, { tone: TONES[i % 3] }),
                    variant === "Steps" && (i < visible - 1 || !working ? /* @__PURE__ */ jsx5("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "var(--ink-3)", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round", className: "shrink-0", children: /* @__PURE__ */ jsx5("path", { d: "M20 6L9 17l-5-5" }) }) : /* @__PURE__ */ jsx5("span", { className: "size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2", style: { animation: reducedMotion ? "none" : "spin 700ms linear infinite" } })),
                    /* @__PURE__ */ jsx5("span", { className: `min-w-0 truncate text-[12.5px] ${variant === "Reasoning" ? "whitespace-normal leading-relaxed text-ink-2" : "font-medium text-ink"} ${variant === "Search" ? "animated-underline" : ""}`, children: row.primary }),
                    row.secondary && /* @__PURE__ */ jsx5("span", { className: `shrink-0 text-[11.5px] text-ink-3 ${row.mono ? "font-mono" : ""}`, children: row.secondary }),
                    row.add !== void 0 && /* @__PURE__ */ jsxs3("span", { className: "shrink-0 font-mono text-[11px] tabular-nums", children: [
                      /* @__PURE__ */ jsxs3("span", { className: "text-green", children: [
                        "+",
                        row.add
                      ] }),
                      " ",
                      /* @__PURE__ */ jsxs3("span", { className: "text-red", children: [
                        "\u2212",
                        row.del
                      ] })
                    ] })
                  ] });
                  const rowClass = "flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left";
                  const animation = { animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${i * 120}ms both` };
                  if (variant === "Search") {
                    return /* @__PURE__ */ jsx5(
                      "a",
                      {
                        href: row.href,
                        target: "_blank",
                        rel: "noreferrer",
                        className: `${rowClass} transition-colors duration-150 hover:bg-hover`,
                        style: animation,
                        children: content
                      },
                      row.primary
                    );
                  }
                  if (variant === "Coding") {
                    const selected = selectedTool === row.primary;
                    return /* @__PURE__ */ jsx5(
                      "button",
                      {
                        type: "button",
                        "aria-pressed": selected,
                        onClick: () => setSelectedTool(selected ? null : row.primary),
                        className: `${rowClass} transition-colors duration-150 ${selected ? "bg-inset" : "hover:bg-hover"}`,
                        style: animation,
                        children: content
                      },
                      row.primary
                    );
                  }
                  return /* @__PURE__ */ jsx5("div", { className: rowClass, style: animation, children: content }, row.primary);
                }),
                variant === "Search" && stage >= 3 && additionalSources > 0 && /* @__PURE__ */ jsxs3("span", { className: "text-[12px] text-ink-3", style: { animation: "fade-in 300ms ease-out both" }, children: [
                  "+",
                  additionalSources,
                  " more"
                ] })
              ] })
            ] }) })
          }
        )
      ]
    },
    variant
  );
}

// src/components/primitives/StreamingText.tsx
import { useEffect as useEffect5, useRef as useRef4, useState as useState5 } from "react";
import { jsx as jsx6, jsxs as jsxs4 } from "react/jsx-runtime";
var WORD_MS = 55;
var HOLD_MS = 3400;
var TOKENS = [
  ..."Leah and Owen are ready for your review. Both included integration examples that match the proposed partner criteria.".split(" ").map((text) => ({ text })),
  { text: "", cite: true },
  ..."I saved the evidence with each application. Admission and access still need human approval.".split(" ").map((text) => ({ text }))
];
var FOLLOW_UPS = [
  "Show the application evidence",
  "Draft a follow-up for missing details"
];
var SOURCE_GLYPH = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#f6f4ff"/><stop offset="1" stop-color="#9ea0e5"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="#302888"/><path d="M20 14h17l9 9v27H20z" fill="url(#g)"/><path d="M27 30h12M27 37h12M27 44h8" stroke="#302888" stroke-width="3"/></svg>`);
var SOURCES = [
  { name: "Proposed partner criteria", domain: "Program guide", href: "#context-cards", image: SOURCE_GLYPH },
  { name: "Leah\u2019s application", domain: "Leah", href: "#approval-card", image: SOURCE_GLYPH },
  { name: "Owen\u2019s application", domain: "Owen", href: "#approval-card", image: SOURCE_GLYPH }
];
function sourceImage(source) {
  return source.image;
}
function SourceChip({ source }) {
  if (!source) return null;
  return /* @__PURE__ */ jsxs4(
    "a",
    {
      href: source.href,
      target: "_blank",
      rel: "noreferrer",
      className: "ml-0 mr-1 inline-flex h-4.5 translate-y-[-1px] items-center gap-1 rounded-[5px]\n        bg-inset pr-[3px] pl-[3px] align-middle font-mono text-[10.5px] text-ink-2 shadow-hairline\n        transition-colors duration-150 hover:bg-hover hover:text-ink",
      style: { animation: "pop-in 250ms cubic-bezier(0.23,1,0.32,1) both" },
      children: [
        /* @__PURE__ */ jsx6("img", { src: sourceImage(source), alt: "", className: "source-avatar size-3 rounded-[3px]" }),
        /* @__PURE__ */ jsx6("span", { children: source.domain })
      ]
    }
  );
}
var ACTION_ICONS = [
  /* @__PURE__ */ jsxs4("g", { children: [
    /* @__PURE__ */ jsx6("rect", { x: "9", y: "9", width: "12", height: "12", rx: "2.5" }),
    /* @__PURE__ */ jsx6("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
  ] }, "copy"),
  /* @__PURE__ */ jsx6("path", { d: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" }, "retry"),
  /* @__PURE__ */ jsx6("path", { d: "M7 10v12M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z" }, "up"),
  /* @__PURE__ */ jsx6("path", { d: "M17 14V2M9 18.12L10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z" }, "down")
];
var DEFAULT_LABELS = {
  sources: "3 sources",
  followUps: "Follow-ups"
};
function StreamingText({
  content = TOKENS,
  sources = SOURCES,
  followUps = FOLLOW_UPS,
  labels,
  loop = true,
  fill = false,
  onDone,
  onFollowUp,
  onAction
} = {}) {
  const reducedMotion = useReducedMotion();
  const l = { ...DEFAULT_LABELS, sources: `${sources.length} sources`, ...labels };
  const [count, setCount] = useState5(0);
  const [sourcesOpen, setSourcesOpen] = useState5(false);
  const done = reducedMotion || count >= content.length;
  const [actionFeedback, setActionFeedback] = useState5("");
  const doneRef = useRef4(false);
  const feedbackTimer = useRef4(null);
  useEffect5(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);
  useEffect5(() => {
    setCount(0);
    setSourcesOpen(false);
    doneRef.current = false;
  }, [content]);
  useEffect5(() => {
    if (reducedMotion || done && !loop) return;
    const t = setTimeout(
      () => setCount((c) => c >= content.length ? 0 : c + 1),
      done ? HOLD_MS : WORD_MS
    );
    return () => clearTimeout(t);
  }, [count, done, loop, content.length, reducedMotion]);
  useEffect5(() => {
    if (!done) {
      doneRef.current = false;
      return;
    }
    if (!doneRef.current) {
      doneRef.current = true;
      onDone?.();
    }
  }, [done, onDone]);
  const act = async (index) => {
    const action = ["copy", "retry", "helpful", "collective"][index];
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(content.filter((token) => !token.cite).map((token) => token.text).join(" "));
        setActionFeedback("Copied");
      } catch {
        setActionFeedback("Couldn\u2019t copy. Select the response to copy it.");
      }
    } else if (action === "retry") {
      setCount(0);
      setSourcesOpen(false);
      doneRef.current = false;
      setActionFeedback("Replaying response");
    } else {
      setActionFeedback(action === "helpful" ? "Feedback noted" : "Ready to add to Collective");
    }
    onAction?.(action);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setActionFeedback(""), 2200);
  };
  return /* @__PURE__ */ jsxs4("div", { "data-reduced-motion": reducedMotion || void 0, className: fill ? "w-full" : "min-h-[15.5rem] w-full max-w-95", children: [
    /* @__PURE__ */ jsxs4("p", { className: "text-[13px] leading-relaxed text-ink", children: [
      content.slice(0, reducedMotion ? content.length : count).map(
        (token, i) => token.cite ? /* @__PURE__ */ jsx6(SourceChip, { source: sources[0] }, i) : /* @__PURE__ */ jsxs4("span", { className: "inline", children: [
          token.text,
          " "
        ] }, i)
      ),
      !done && /* @__PURE__ */ jsx6(
        "span",
        {
          className: "ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 rounded-full bg-ink",
          style: { animation: "fade-in 150ms ease-out both" }
        }
      )
    ] }),
    /* @__PURE__ */ jsxs4(
      "div",
      {
        inert: !done,
        className: "mt-2 flex items-center gap-0.5 transition-opacity duration-400",
        style: { opacity: done ? 1 : 0, pointerEvents: done ? "auto" : "none" },
        children: [
          ACTION_ICONS.map((icon, i) => /* @__PURE__ */ jsx6(
            "button",
            {
              type: "button",
              "aria-label": ["Copy response", "Replay response", "Helpful response", "Add to Collective"][i],
              title: ["Copy response", "Replay response", "Helpful response", "Add to Collective"][i],
              onClick: () => void act(i),
              className: "flex size-6 items-center justify-center rounded-[6px] text-ink-3\n              transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2",
              children: /* @__PURE__ */ jsx6("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: i === 3 ? /* @__PURE__ */ jsxs4("g", { children: [
                /* @__PURE__ */ jsx6("path", { d: "M12 3 3 8v9l9 5 9-5V8zM3 8l9 5 9-5M12 13v9" }),
                /* @__PURE__ */ jsx6("path", { d: "M16 3v6M13 6h6" })
              ] }) : icon })
            },
            i
          )),
          /* @__PURE__ */ jsxs4(
            "button",
            {
              type: "button",
              "aria-expanded": sourcesOpen,
              onClick: () => setSourcesOpen((current) => !current),
              className: "ml-1.5 flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left transition-colors duration-150 hover:bg-hover",
              children: [
                /* @__PURE__ */ jsx6("span", { className: "flex -space-x-1", children: sources.map((source) => /* @__PURE__ */ jsx6(
                  "img",
                  {
                    src: sourceImage(source),
                    alt: "",
                    className: "source-avatar size-3.5 rounded-full bg-surface shadow-[0_0_0_1.5px_var(--canvas)]"
                  },
                  source.domain
                )) }),
                /* @__PURE__ */ jsx6("span", { className: "text-[12px] text-ink-2", children: l.sources })
              ]
            }
          )
        ]
      }
    ),
    /* @__PURE__ */ jsx6(
      "div",
      {
        inert: !(done && sourcesOpen),
        className: "grid transition-[grid-template-rows,opacity] duration-300",
        style: {
          gridTemplateRows: done && sourcesOpen ? "1fr" : "0fr",
          opacity: done && sourcesOpen ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)"
        },
        children: /* @__PURE__ */ jsx6("div", { className: "overflow-hidden", children: /* @__PURE__ */ jsx6("div", { className: "mt-1.5 flex flex-col rounded-[10px] bg-inset p-1 shadow-hairline", children: sources.map((source) => /* @__PURE__ */ jsxs4(
          "a",
          {
            href: source.href,
            target: "_blank",
            rel: "noreferrer",
            className: "flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink",
            children: [
              /* @__PURE__ */ jsx6("img", { src: sourceImage(source), alt: "", className: "source-avatar size-4 rounded-[4px]" }),
              /* @__PURE__ */ jsx6("span", { className: "animated-underline", children: source.name }),
              /* @__PURE__ */ jsx6("span", { className: "ml-auto font-mono text-[10.5px] text-ink-3", children: source.domain })
            ]
          },
          source.domain
        )) }) })
      }
    ),
    /* @__PURE__ */ jsx6("span", { role: "status", className: "sr-only", children: actionFeedback }),
    /* @__PURE__ */ jsxs4(
      "div",
      {
        inert: !done,
        className: "mt-2.5 transition-opacity duration-400",
        style: { opacity: done ? 1 : 0, pointerEvents: done ? "auto" : "none" },
        children: [
          /* @__PURE__ */ jsx6("p", { className: "text-[12px] font-medium text-ink-2", children: l.followUps }),
          /* @__PURE__ */ jsx6("div", { className: "mt-0.5 flex flex-col", children: followUps.map((text, i) => /* @__PURE__ */ jsxs4(
            "button",
            {
              type: "button",
              onClick: () => onFollowUp?.(text, i),
              className: "-mx-1.5 flex items-center gap-2 rounded-[7px] border-b border-line\n                px-1.5 py-1.5 text-left text-[12.5px] text-ink transition-colors\n                duration-100 hover:bg-hover-2",
              style: done ? { animation: `fade-up 350ms cubic-bezier(0.23,1,0.32,1) ${i * 90}ms both` } : { opacity: 0 },
              children: [
                /* @__PURE__ */ jsxs4("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "var(--ink-3)", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", className: "shrink-0", children: [
                  /* @__PURE__ */ jsx6("path", { d: "M9 10l-5 5 5 5" }),
                  /* @__PURE__ */ jsx6("path", { d: "M20 4v7a4 4 0 0 1-4 4H4" })
                ] }),
                text
              ]
            },
            text
          )) })
        ]
      }
    )
  ] });
}

// src/components/primitives/ApprovalCard.tsx
import { useEffect as useEffect6, useLayoutEffect as useLayoutEffect2, useRef as useRef6, useState as useState7 } from "react";

// src/components/primitives/GlideMenu.tsx
import { useRef as useRef5, useState as useState6 } from "react";
import { jsx as jsx7, jsxs as jsxs5 } from "react/jsx-runtime";
function GlideMenu({
  children,
  className = "",
  highlightClassName = "inset-x-0 rounded-[8px] bg-hover",
  rowSelector = "[data-menu-row]"
}) {
  const ref = useRef5(null);
  const [box, setBox] = useState6(null);
  const [visible, setVisible] = useState6(false);
  const moveTo = (target) => {
    const container = ref.current;
    if (!(target instanceof Element) || !container) return;
    const row = target.closest(rowSelector);
    if (!(row instanceof HTMLElement) || !container.contains(row)) return;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    setBox({ top: rowRect.top - containerRect.top, height: rowRect.height });
    setVisible(true);
  };
  return /* @__PURE__ */ jsxs5(
    "div",
    {
      ref,
      onMouseOver: (event) => moveTo(event.target),
      onMouseLeave: () => setVisible(false),
      onFocusCapture: (event) => moveTo(event.target),
      onBlurCapture: (event) => {
        if (!ref.current?.contains(event.relatedTarget)) setVisible(false);
      },
      className: `group/glide-menu relative ${className}`,
      children: [
        /* @__PURE__ */ jsx7(
          "span",
          {
            "aria-hidden": true,
            className: `pointer-events-none absolute ${highlightClassName}`,
            style: {
              top: box?.top ?? 0,
              height: box?.height ?? 0,
              opacity: box && visible ? 1 : 0,
              transition: "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease"
            }
          }
        ),
        children
      ]
    }
  );
}

// src/components/primitives/ApprovalCard.tsx
import { Fragment as Fragment3, jsx as jsx8, jsxs as jsxs6 } from "react/jsx-runtime";
var QUESTIONS = [
  {
    q: "How many prospects should Iris shortlist?",
    type: "radio",
    options: ["Five prospects", "Ten prospects", "Twenty prospects"]
  },
  {
    q: "What should Iris check?",
    type: "check",
    options: ["Integration experience", "Customer reach", "Public work"]
  },
  {
    q: "What happens after screening?",
    type: "radio",
    options: ["Send Maya the shortlist", "Save drafts for review", "Request missing evidence"]
  }
];
var DEFAULT_LABELS2 = {
  skip: "Skip",
  continue: "Continue",
  send: "Send",
  customPlaceholder: "Something else\u2026",
  sentMessage: "Answers sent"
};
var ROLL_MS = 400;
var SLIDE = "360ms cubic-bezier(0.22, 1, 0.36, 1)";
function RollingDigits({ value }) {
  const reduce = useReducedMotion();
  const prevRef = useRef6(value);
  const [oldVal, setOldVal] = useState7(value);
  const [newVal, setNewVal] = useState7(value);
  const [rolling, setRolling] = useState7(false);
  const [shifted, setShifted] = useState7(false);
  const [dir, setDir] = useState7("up");
  useEffect6(() => {
    if (prevRef.current === value) return;
    if (reduce) {
      prevRef.current = value;
      setOldVal(value);
      setNewVal(value);
      setRolling(false);
      return;
    }
    const from = prevRef.current;
    prevRef.current = value;
    const fromN = parseInt(from, 10);
    const toN = parseInt(value, 10);
    setDir(Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN ? "down" : "up");
    setOldVal(from);
    setNewVal(value);
    setRolling(true);
    setShifted(false);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true));
    });
    const done = setTimeout(() => {
      setRolling(false);
      setOldVal(value);
      setShifted(false);
    }, ROLL_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(done);
    };
  }, [value, reduce]);
  const chars = rolling ? newVal : oldVal;
  return /* @__PURE__ */ jsx8(Fragment3, { children: Array.from({ length: chars.length }, (_, i) => {
    const o = oldVal[i] ?? "";
    const n = chars[i] ?? "";
    if (!rolling || o === n) {
      return /* @__PURE__ */ jsx8("span", { children: n }, `${i}-${n}`);
    }
    const top = dir === "down" ? n : o;
    const bottom = dir === "down" ? o : n;
    const restY = dir === "down" ? "0" : "-1em";
    const startY = dir === "down" ? "-1em" : "0";
    return /* @__PURE__ */ jsx8(
      "span",
      {
        style: { display: "inline-block", position: "relative", overflow: "hidden", height: "1em", lineHeight: "1em", verticalAlign: "-0.05em" },
        children: /* @__PURE__ */ jsxs6(
          "span",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              transition: "transform 350ms cubic-bezier(0.4, 0, 0.2, 1)",
              transform: `translateY(${shifted ? restY : startY})`
            },
            children: [
              /* @__PURE__ */ jsx8("span", { style: { height: "1em", lineHeight: "1em" }, children: top }),
              /* @__PURE__ */ jsx8("span", { style: { height: "1em", lineHeight: "1em" }, children: bottom })
            ]
          }
        )
      },
      `${i}-${o}-${n}-${dir}`
    );
  }) });
}
function Ico({ path, size = 14, sw = 2 }) {
  return /* @__PURE__ */ jsx8("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: path });
}
function ApprovalCard({
  questions = QUESTIONS,
  labels,
  onSubmitted,
  onAnswerChange,
  onReset,
  resettable = true
} = {}) {
  const reduce = useReducedMotion();
  const t = { ...DEFAULT_LABELS2, ...labels };
  const [qi, setQi] = useState7(0);
  const [answers, setAnswers] = useState7({});
  const [custom, setCustom] = useState7({});
  const [sent, setSent] = useState7(false);
  const [open, setOpen] = useState7(true);
  const answersRef = useRef6(answers);
  const customRef = useRef6(custom);
  answersRef.current = answers;
  customRef.current = custom;
  const advanceTimer = useRef6(null);
  const questionRefs = useRef6([]);
  const previousQuestionRef = useRef6(qi);
  const measured = useRef6(false);
  const [viewportH, setViewportH] = useState7(void 0);
  const [trackY, setTrackY] = useState7(0);
  const [animate, setAnimate] = useState7(false);
  const [ready, setReady] = useState7(false);
  const last = qi === questions.length - 1;
  const selected = answers[qi] ?? [];
  const hasAnswer = selected.length > 0 || Boolean(custom[qi]?.trim());
  const sync = (withAnim) => {
    const item = questionRefs.current[qi];
    if (!item) return;
    setViewportH(item.offsetHeight);
    setTrackY(item.offsetTop);
    setAnimate(withAnim && !reduce);
  };
  useLayoutEffect2(() => {
    const withAnim = measured.current;
    measured.current = true;
    sync(withAnim);
    setReady(true);
  }, [qi, answers, custom, open, sent, reduce]);
  useLayoutEffect2(() => {
    if (previousQuestionRef.current === qi) return;
    previousQuestionRef.current = qi;
    questionRefs.current[qi]?.querySelector("[data-question-heading]")?.focus({ preventScroll: true });
  }, [qi]);
  useEffect6(() => {
    const id = requestAnimationFrame(() => sync(measured.current));
    return () => cancelAnimationFrame(id);
  }, [qi]);
  useEffect6(() => () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
  }, []);
  useEffect6(() => {
    const item = questionRefs.current[qi];
    if (!item) return;
    const observer = new ResizeObserver(() => sync(false));
    observer.observe(item);
    return () => observer.disconnect();
  }, [qi, open, sent, reduce]);
  const goTo = (next) => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setQi(Math.min(Math.max(next, 0), questions.length - 1));
  };
  const send = () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setSent(true);
    onSubmitted?.(answersRef.current, customRef.current);
  };
  const advance = () => {
    if (last) send();
    else goTo(qi + 1);
  };
  const toggle = (index) => {
    const type = questions[qi].type;
    const picked = answersRef.current[qi] ?? [];
    const next = type === "radio" ? [index] : picked.includes(index) ? picked.filter((item) => item !== index) : [...picked, index];
    const nextAnswers = { ...answersRef.current, [qi]: next };
    answersRef.current = nextAnswers;
    setAnswers(nextAnswers);
    onAnswerChange?.(qi, next);
    if (type === "radio") {
      setCustom((current) => ({ ...current, [qi]: "" }));
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => {
        if (last) send();
        else setQi((current) => Math.min(questions.length - 1, current + 1));
      }, 480);
    }
  };
  const reset = () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setQi(0);
    setAnswers({});
    setCustom({});
    setSent(false);
    setOpen(true);
    measured.current = false;
    onReset?.();
  };
  if (!questions.length) return null;
  if (!open) {
    return /* @__PURE__ */ jsx8("button", { type: "button", onClick: () => setOpen(true), className: "rounded-control bg-surface px-3 py-2 text-[12.5px] font-medium text-ink shadow-btn transition-colors duration-150 hover:bg-hover", children: "Open decision prompt" });
  }
  if (sent) {
    return /* @__PURE__ */ jsxs6("div", { className: "flex w-full max-w-80 items-center gap-3", style: { animation: "pop-in 260ms cubic-bezier(0.23,1,0.32,1) both" }, children: [
      /* @__PURE__ */ jsxs6("span", { className: "inline-flex items-center gap-1.5 rounded-full bg-green-tint py-1 pr-2.5 pl-1 text-[12.5px] font-medium text-green", children: [
        /* @__PURE__ */ jsx8("span", { className: "flex size-4.5 items-center justify-center rounded-full bg-green text-white", children: /* @__PURE__ */ jsx8("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "3", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx8("path", { d: "M20 6L9 17l-5-5" }) }) }),
        t.sentMessage
      ] }),
      resettable && /* @__PURE__ */ jsx8("button", { type: "button", onClick: reset, className: "text-[12px] font-medium text-ink-3 transition-colors duration-150 hover:text-ink", children: "Start over" })
    ] });
  }
  return /* @__PURE__ */ jsx8("div", { className: "w-full max-w-80", children: /* @__PURE__ */ jsxs6("div", { className: "relative overflow-hidden rounded-card bg-surface shadow-card", style: { animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }, children: [
    /* @__PURE__ */ jsx8(
      "button",
      {
        type: "button",
        "aria-label": "Dismiss",
        onClick: () => {
          if (advanceTimer.current) clearTimeout(advanceTimer.current);
          setOpen(false);
        },
        className: "primitive-icon-button absolute right-2.5 top-2.5 z-10 text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink",
        children: /* @__PURE__ */ jsx8(Ico, { size: 14, sw: 2.2, path: /* @__PURE__ */ jsx8("path", { d: "M18 6L6 18M6 6l12 12" }) })
      }
    ),
    /* @__PURE__ */ jsx8("div", { className: "primitive-card-pad", children: /* @__PURE__ */ jsx8(
      "div",
      {
        className: "overflow-hidden",
        style: { height: viewportH, transition: animate ? `height ${SLIDE}` : void 0 },
        "aria-live": "polite",
        children: /* @__PURE__ */ jsx8(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 26,
              transform: `translate3d(0, ${-trackY}px, 0)`,
              transition: animate ? `transform ${SLIDE}` : void 0,
              willChange: "transform"
            },
            children: questions.map((question, qIdx) => {
              const active = qIdx === qi;
              if (!ready && !active) return null;
              const picked = answers[qIdx] ?? [];
              const questionStyle = {
                opacity: active ? 1 : 0,
                transition: animate ? `opacity ${SLIDE}` : void 0,
                pointerEvents: active ? void 0 : "none"
              };
              return /* @__PURE__ */ jsxs6(
                "div",
                {
                  ref: (el) => {
                    questionRefs.current[qIdx] = el;
                  },
                  "aria-hidden": active ? void 0 : true,
                  style: questionStyle,
                  children: [
                    /* @__PURE__ */ jsx8("div", { "data-question-heading": true, role: "heading", "aria-level": 3, tabIndex: -1, className: "pr-7 text-[14px] font-medium text-ink", children: question.q }),
                    /* @__PURE__ */ jsxs6(GlideMenu, { className: "mt-2.5 flex flex-col gap-1", highlightClassName: "inset-x-0 rounded-control bg-hover", children: [
                      question.options.map((option, i) => {
                        const on = picked.includes(i);
                        return /* @__PURE__ */ jsxs6(
                          "button",
                          {
                            type: "button",
                            "data-menu-row": true,
                            "aria-pressed": on,
                            tabIndex: active ? 0 : -1,
                            onClick: () => {
                              if (active) toggle(i);
                            },
                            className: "relative z-10 flex items-center gap-1.5 rounded-control pl-1 pr-2 py-1 text-left transition-colors duration-100",
                            children: [
                              /* @__PURE__ */ jsx8(
                                "span",
                                {
                                  className: `flex size-4 shrink-0 items-center justify-center transition-colors duration-200
                                ${question.type === "radio" ? "rounded-full" : "rounded-[5px]"}
                                ${on ? "bg-ink text-canvas" : "shadow-[inset_0_0_0_1.5px_var(--line-strong)] text-transparent"}`,
                                  children: question.type === "radio" ? /* @__PURE__ */ jsx8("span", { className: "size-1.5 rounded-full bg-canvas transition-transform duration-200", style: { transform: on ? "scale(1)" : "scale(0)" } }) : /* @__PURE__ */ jsx8("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "3", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx8("path", { d: "M20 6L9 17l-5-5" }) })
                                }
                              ),
                              /* @__PURE__ */ jsx8("span", { className: `text-[13px] leading-none transition-colors duration-200 ${on ? "text-ink" : "text-ink-2"}`, children: option })
                            ]
                          },
                          option
                        );
                      }),
                      /* @__PURE__ */ jsx8("label", { "data-menu-row": true, className: "relative z-10 flex items-center gap-1.5 rounded-control pl-1 pr-2 py-1 transition-colors duration-100", children: /* @__PURE__ */ jsx8(
                        "input",
                        {
                          value: custom[qIdx] ?? "",
                          tabIndex: active ? 0 : -1,
                          onChange: (event) => {
                            if (!active) return;
                            if (advanceTimer.current) clearTimeout(advanceTimer.current);
                            setCustom((current) => ({ ...current, [qIdx]: event.target.value }));
                            if (question.type === "radio") setAnswers((current) => ({ ...current, [qIdx]: [] }));
                          },
                          onKeyDown: (event) => {
                            if (event.key === "Enter" && hasAnswer) {
                              event.preventDefault();
                              advance();
                            }
                          },
                          placeholder: t.customPlaceholder,
                          "aria-label": "Custom answer",
                          className: "min-w-0 flex-1 bg-transparent pl-1.5 text-[13px] text-ink outline-none placeholder:text-ink-3"
                        }
                      ) })
                    ] })
                  ]
                },
                qIdx
              );
            })
          }
        )
      }
    ) }),
    /* @__PURE__ */ jsxs6("div", { className: "primitive-card-footer flex items-center justify-between gap-3", children: [
      /* @__PURE__ */ jsxs6("div", { className: "flex items-center gap-1 text-ink-3", children: [
        /* @__PURE__ */ jsx8(
          "button",
          {
            type: "button",
            "aria-label": "Previous question",
            disabled: qi <= 0,
            onClick: () => goTo(qi - 1),
            className: "flex size-[18px] items-center justify-center rounded-[5px] transition-colors duration-100 enabled:hover:text-ink disabled:opacity-30",
            children: /* @__PURE__ */ jsx8(Ico, { size: 14, path: /* @__PURE__ */ jsx8("path", { d: "M18 15l-6-6-6 6" }) })
          }
        ),
        /* @__PURE__ */ jsx8("span", { className: "inline-flex items-center text-[12px] font-medium tabular-nums text-ink-3", style: { letterSpacing: "-0.1px", lineHeight: 1 }, children: /* @__PURE__ */ jsx8(RollingDigits, { value: `${qi + 1} / ${questions.length}` }) }),
        /* @__PURE__ */ jsx8(
          "button",
          {
            type: "button",
            "aria-label": "Next question",
            disabled: last,
            onClick: () => goTo(qi + 1),
            className: "flex size-[18px] items-center justify-center rounded-[5px] transition-colors duration-100 enabled:hover:text-ink disabled:opacity-30",
            children: /* @__PURE__ */ jsx8(Ico, { size: 14, path: /* @__PURE__ */ jsx8("path", { d: "M6 9l6 6 6-6" }) })
          }
        )
      ] }),
      /* @__PURE__ */ jsxs6("div", { className: "-mr-0.5 flex items-center gap-1.5", children: [
        /* @__PURE__ */ jsx8(Button, { variant: "ghost", size: "sm", onClick: () => {
          if (advanceTimer.current) clearTimeout(advanceTimer.current);
          if (last) setOpen(false);
          else goTo(qi + 1);
        }, children: t.skip }),
        /* @__PURE__ */ jsx8(Button, { variant: "accent", size: "sm", disabled: !hasAnswer, onClick: advance, children: last ? t.send : t.continue })
      ] })
    ] })
  ] }) });
}

// src/components/primitives/ToolChips.tsx
import { useEffect as useEffect7, useState as useState8 } from "react";
import { createPortal as createPortal2 } from "react-dom";
import { jsx as jsx9, jsxs as jsxs7 } from "react/jsx-runtime";
var STEP_MS = 700;
var Icons = {
  think: /* @__PURE__ */ jsx9("path", { d: "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" }),
  write: /* @__PURE__ */ jsx9("g", { fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx9("path", { d: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" }) }),
  run: /* @__PURE__ */ jsx9("g", { fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx9("path", { d: "M4 17l6-5-6-5M12 19h8" }) }),
  read: /* @__PURE__ */ jsxs7("g", { fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [
    /* @__PURE__ */ jsx9("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }),
    /* @__PURE__ */ jsx9("path", { d: "M14 2v6h6" })
  ] })
};
var DEFAULT_LABELS3 = {
  header: "4 tool calls",
  more: "View all changes"
};
var ROWS = [
  {
    icon: "read",
    label: "Read criteria",
    chip: "partner-criteria.md",
    mono: true,
    detailMono: false,
    detail: [{ text: "Proposed criteria \xB7 integration evidence required." }, { text: "Admission and access need human review." }]
  },
  {
    icon: "read",
    label: "Read applications",
    chip: "Leah + Owen",
    mono: false,
    detailMono: false,
    detail: [{ text: "2 applications with integration examples." }, { text: "No access has been granted." }]
  },
  {
    icon: "run",
    label: "Check evidence",
    chip: "verify-applications",
    mono: true,
    detailMono: true,
    detail: [{ text: "\u2713 2 application records checked" }, { text: "\u2713 Missing fields marked for review" }]
  },
  {
    icon: "write",
    label: "Save summaries",
    chip: "review-notes.md",
    mono: true,
    detailMono: false,
    detail: [{ text: "2 drafts saved for Maya." }, { text: "Nothing sent. Decisions remain in Inbox." }]
  }
];
var DIFFS = [
  { file: "review-notes.md", add: 2, del: 0 },
  { file: "screening.json", add: 1, del: 1 },
  { file: "follow-ups.md", add: 1, del: 0 }
];
var DIFF_LINES = {
  "review-notes.md": [
    { text: "# Application review", tone: "ctx" },
    { text: "Leah: integration example attached.", tone: "add" },
    { text: "Owen: integration example attached.", tone: "add" }
  ],
  "screening.json": [
    { text: '"status": "unscreened"', tone: "del" },
    { text: '"status": "needs_review"', tone: "add" },
    { text: '"reviewer": "Maya Chen"', tone: "ctx" }
  ],
  "follow-ups.md": [
    { text: "Confirm onboarding availability after admission.", tone: "add" }
  ]
};
function ToolChips({
  steps = ROWS,
  diffs = DIFFS,
  diffLines = DIFF_LINES,
  labels,
  className,
  onOpenChange,
  onToggleRow,
  onMore
} = {}) {
  const reducedMotion = useReducedMotion();
  const copy = { ...DEFAULT_LABELS3, header: `${steps.length} tool calls`, ...labels };
  const [step, setStep] = useState8(0);
  const [open, setOpen] = useState8(true);
  const [openRows, setOpenRows] = useState8(/* @__PURE__ */ new Set());
  const [preview, setPreview] = useState8(null);
  const openPreview = (file) => (event) => {
    const rect = event.currentTarget.closest("[data-diffchip]").getBoundingClientRect();
    const previewHeight = 38 + (diffLines[file]?.length ?? 0) * 19;
    const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
    setPreview({
      file,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...fitsBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }
    });
  };
  const closePreview = (file) => () => setPreview((current) => current?.file === file ? null : current);
  const total = steps.length + 1;
  useEffect7(() => {
    if (reducedMotion || step >= total) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [step, total, reducedMotion]);
  useEffect7(() => {
    if (!preview) return;
    const close = () => setPreview(null);
    const escape = (event) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", escape);
    };
  }, [preview]);
  const toggleRow = (label) => {
    const next = new Set(openRows);
    next.has(label) ? next.delete(label) : next.add(label);
    setOpenRows(next);
    onToggleRow?.(label, next.has(label));
  };
  return /* @__PURE__ */ jsxs7("div", { "data-reduced-motion": reducedMotion || void 0, className: `min-h-[220px] w-full max-w-80 pb-1${className ? ` ${className}` : ""}`, children: [
    /* @__PURE__ */ jsxs7(
      "button",
      {
        type: "button",
        "aria-expanded": open,
        onClick: () => {
          setOpen(!open);
          onOpenChange?.(!open);
        },
        className: "-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2",
        children: [
          /* @__PURE__ */ jsx9("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round", className: "transition-transform duration-200", style: { transform: open ? "rotate(0deg)" : "rotate(-90deg)" }, children: /* @__PURE__ */ jsx9("path", { d: "M6 9l6 6 6-6" }) }),
          /* @__PURE__ */ jsx9("span", { className: "tabular-nums", children: copy.header })
        ]
      }
    ),
    /* @__PURE__ */ jsx9("div", { inert: !open, className: "grid transition-[grid-template-rows,opacity] duration-300", style: { gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }, children: /* @__PURE__ */ jsxs7("div", { className: "-mx-1 overflow-hidden px-1.5 pb-1", children: [
      /* @__PURE__ */ jsx9("div", { className: "mt-1.5 flex flex-col gap-1", children: steps.slice(0, reducedMotion ? steps.length : step).map((row) => {
        const rowOpen = openRows.has(row.label);
        return /* @__PURE__ */ jsxs7("div", { style: { animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }, children: [
          /* @__PURE__ */ jsxs7(
            "button",
            {
              type: "button",
              "aria-expanded": rowOpen,
              onClick: () => toggleRow(row.label),
              className: "group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 hover:bg-hover-2",
              children: [
                /* @__PURE__ */ jsxs7("span", { className: "relative flex size-4 shrink-0 items-center justify-center text-ink-3", children: [
                  /* @__PURE__ */ jsx9(
                    "svg",
                    {
                      width: "13",
                      height: "13",
                      viewBox: "0 0 24 24",
                      fill: row.icon === "think" ? "currentColor" : "none",
                      stroke: "currentColor",
                      className: `transition-opacity duration-100 group-hover/row:opacity-0 ${rowOpen ? "opacity-0" : ""}`,
                      children: Icons[row.icon]
                    }
                  ),
                  /* @__PURE__ */ jsx9(
                    "svg",
                    {
                      width: "12",
                      height: "12",
                      viewBox: "0 0 24 24",
                      fill: "none",
                      stroke: "currentColor",
                      strokeWidth: "2.2",
                      strokeLinecap: "round",
                      strokeLinejoin: "round",
                      className: `absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${rowOpen ? "opacity-100" : "opacity-0"}`,
                      style: { transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" },
                      children: /* @__PURE__ */ jsx9("path", { d: "M6 9l6 6 6-6" })
                    }
                  )
                ] }),
                /* @__PURE__ */ jsx9("span", { className: "shrink-0 text-[12.5px] font-medium text-ink", children: row.label }),
                /* @__PURE__ */ jsx9(
                  "span",
                  {
                    className: `inline-flex h-5.5 min-w-0 flex-1 cursor-pointer items-center truncate rounded-chip bg-field px-1.5
                    text-[11.5px] text-ink-2 shadow-hairline transition-colors duration-100 hover:bg-hover-2
                    ${row.mono ? "font-mono" : ""}`,
                    children: row.chip
                  }
                )
              ]
            }
          ),
          /* @__PURE__ */ jsx9(
            "div",
            {
              inert: !rowOpen,
              className: "grid transition-[grid-template-rows,opacity] duration-300",
              style: { gridTemplateRows: rowOpen ? "1fr" : "0fr", opacity: rowOpen ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" },
              children: /* @__PURE__ */ jsx9("div", { className: "min-h-0 overflow-hidden", children: /* @__PURE__ */ jsx9("div", { className: "mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-line py-0.5 pl-3.5", children: row.detail.map((line) => /* @__PURE__ */ jsx9(
                "span",
                {
                  className: `truncate text-[11.5px] leading-[1.6] ${row.detailMono ? "font-mono" : ""} ${line.tone === "add" ? "text-green" : "text-ink-2"}`,
                  children: line.text
                },
                line.text
              )) }) })
            }
          )
        ] }, row.label);
      }) }),
      (reducedMotion || step >= total) && /* @__PURE__ */ jsxs7("div", { className: "mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2.5", children: [
        diffs.map((d, i) => /* @__PURE__ */ jsx9(
          "span",
          {
            "data-diffchip": true,
            className: "relative",
            onMouseEnter: openPreview(d.file),
            onMouseLeave: closePreview(d.file),
            children: /* @__PURE__ */ jsxs7(
              "button",
              {
                type: "button",
                "aria-expanded": preview?.file === d.file,
                "aria-label": `Show diff for ${d.file}`,
                onFocus: openPreview(d.file),
                onClick: openPreview(d.file),
                onKeyDown: (event) => {
                  if (event.key === "Escape") setPreview(null);
                },
                onBlur: closePreview(d.file),
                className: "inline-flex h-7 max-w-full items-center gap-2 rounded-chip\n                  bg-surface px-2 font-mono text-[11.5px] text-ink shadow-btn\n                  transition-colors duration-100 hover:bg-hover",
                style: { animation: `pop-in 250ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both` },
                children: [
                  /* @__PURE__ */ jsx9("span", { className: "min-w-0 truncate", children: d.file }),
                  /* @__PURE__ */ jsxs7("span", { className: "shrink-0 text-green tabular-nums", children: [
                    "+",
                    d.add
                  ] }),
                  d.del > 0 && /* @__PURE__ */ jsxs7("span", { className: "shrink-0 text-red tabular-nums", children: [
                    "\u2212",
                    d.del
                  ] })
                ]
              }
            )
          },
          d.file
        )),
        onMore && /* @__PURE__ */ jsx9(
          "button",
          {
            type: "button",
            onClick: onMore,
            className: "inline-flex h-7 items-center rounded-chip px-1.5 font-mono text-[11.5px] text-ink-3\n              underline decoration-transparent underline-offset-2 transition-colors duration-100\n              hover:text-ink-2 hover:decoration-current",
            style: { animation: `fade-in 300ms ease-out ${diffs.length * 80}ms both` },
            children: copy.more
          }
        )
      ] })
    ] }) }),
    preview && typeof document !== "undefined" && createPortal2(
      /* @__PURE__ */ jsxs7(
        "div",
        {
          role: "tooltip",
          "data-reduced-motion": reducedMotion || void 0,
          className: "hermes-ui fixed z-50 w-72 overflow-hidden rounded-[10px] bg-surface shadow-overlay",
          style: {
            left: preview.x,
            top: preview.top,
            bottom: preview.bottom,
            animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
            transformOrigin: preview.top === void 0 ? "bottom left" : "top left"
          },
          children: [
            /* @__PURE__ */ jsxs7("div", { className: "flex items-center justify-between border-b border-line px-2.5 py-1.5 font-mono text-[11px]", children: [
              /* @__PURE__ */ jsx9("span", { className: "min-w-0 truncate text-ink-2", children: preview.file }),
              /* @__PURE__ */ jsxs7("span", { className: "shrink-0 tabular-nums", children: [
                /* @__PURE__ */ jsxs7("span", { className: "text-green", children: [
                  "+",
                  diffs.find((diff) => diff.file === preview.file)?.add
                ] }),
                (diffs.find((diff) => diff.file === preview.file)?.del ?? 0) > 0 && /* @__PURE__ */ jsxs7("span", { className: "text-red", children: [
                  " \u2212",
                  diffs.find((diff) => diff.file === preview.file)?.del
                ] })
              ] })
            ] }),
            /* @__PURE__ */ jsx9("div", { className: "py-1 font-mono text-[11px] leading-[1.8]", children: (diffLines[preview.file] ?? []).map((line, index) => /* @__PURE__ */ jsxs7(
              "div",
              {
                className: `flex gap-2 px-2.5 whitespace-pre ${line.tone === "add" ? "bg-green-tint text-green" : line.tone === "del" ? "bg-red-tint text-red" : "text-ink-2"}`,
                children: [
                  /* @__PURE__ */ jsx9("span", { className: "w-3 shrink-0 select-none", children: line.tone === "add" ? "+" : line.tone === "del" ? "\u2212" : " " }),
                  /* @__PURE__ */ jsx9("span", { className: "min-w-0 truncate", children: line.text })
                ]
              },
              index
            )) })
          ]
        }
      ),
      document.body
    )
  ] });
}

// src/components/primitives/TaskRows.tsx
import { useEffect as useEffect8, useState as useState9 } from "react";
import { jsx as jsx10, jsxs as jsxs8 } from "react/jsx-runtime";
var TICKS = [600, 900, 2400, 1400, 2400, 600];
function useTick(intervals, reducedMotion) {
  const [tick, setTick] = useState9(0);
  useEffect8(() => {
    if (reducedMotion || tick >= intervals.length - 1) return;
    const t = setTimeout(() => setTick((x) => x + 1), intervals[tick]);
    return () => clearTimeout(t);
  }, [tick, intervals, reducedMotion]);
  return reducedMotion ? intervals.length - 1 : tick;
}
function SpinnerRing({ active, children }) {
  const reducedMotion = useReducedMotion();
  const size = 24, stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return /* @__PURE__ */ jsxs8("span", { className: "relative inline-flex shrink-0 items-center justify-center", style: { width: size, height: size }, children: [
    /* @__PURE__ */ jsxs8(
      "svg",
      {
        width: size,
        height: size,
        className: "absolute inset-0",
        style: active && !reducedMotion ? { animation: "spin 1.1s linear infinite" } : void 0,
        children: [
          /* @__PURE__ */ jsx10("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: "var(--line)", strokeWidth: stroke }),
          active && /* @__PURE__ */ jsx10(
            "circle",
            {
              cx: size / 2,
              cy: size / 2,
              r,
              fill: "none",
              stroke: "var(--ink-3)",
              strokeWidth: stroke,
              strokeLinecap: "round",
              strokeDasharray: `${c * 0.28} ${c * 0.72}`
            }
          )
        ]
      }
    ),
    /* @__PURE__ */ jsx10("span", { className: "relative text-[10.5px] font-semibold tabular-nums text-ink", children })
  ] });
}
function Badge({ tone, children }) {
  return /* @__PURE__ */ jsx10(
    "span",
    {
      className: `flex size-5.5 shrink-0 items-center justify-center rounded-full text-white
        ${tone === "red" ? "bg-red" : "bg-green"}`,
      style: { animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" },
      children
    }
  );
}
var XIcon = /* @__PURE__ */ jsx10("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "3.5", strokeLinecap: "round", children: /* @__PURE__ */ jsx10("path", { d: "M18 6L6 18M6 6l12 12" }) });
var CheckIcon = /* @__PURE__ */ jsx10("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "3.5", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx10("path", { d: "M20 6L9 17l-5-5" }) });
var RetryIcon = /* @__PURE__ */ jsx10("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "3", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx10("path", { d: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" }) });
var DEFAULT_LABELS4 = {
  completed: "Completed",
  failed: "Retrying",
  blocked: "Needs review"
};
var TASK_ROWS = [
  {
    key: "verify",
    label: "Checked applications",
    amount: "2 applicants",
    status: "done",
    details: [
      { label: "Matched integration evidence", meta: "2/2" },
      { label: "Missing required fields", meta: "0" }
    ]
  },
  {
    key: "index",
    label: "Research prospects",
    amount: "5 profiles",
    status: "running",
    step: 2,
    details: [
      { label: "Reading public profiles", meta: "3 of 5" },
      { label: "Checking criteria", meta: "2 of 5" }
    ]
  },
  {
    key: "draft",
    label: "Save review drafts",
    amount: "2 drafts",
    status: "sequence",
    step: 3,
    details: [
      { label: "Leah\u2019s application", meta: "draft" },
      { label: "Owen\u2019s application", meta: "draft" }
    ]
  }
];
function TaskRows({
  variant = "Capsules",
  rows = TASK_ROWS,
  labels,
  className,
  onToggleRow,
  onRetry
}) {
  const reducedMotion = useReducedMotion();
  const tick = useTick(TICKS, reducedMotion);
  const [manualOpen, setManualOpen] = useState9({});
  const row2 = tick < 3 ? "pending" : tick === 3 ? "failed" : "done";
  const copy = { ...DEFAULT_LABELS4, ...labels };
  const badgeFor = (row) => {
    if (row.status === "failed") return /* @__PURE__ */ jsx10(Badge, { tone: "red", children: XIcon });
    if (row.status === "blocked") return /* @__PURE__ */ jsx10(SpinnerRing, { children: "!" });
    if (row.status === "done") return /* @__PURE__ */ jsx10(Badge, { tone: "green", children: CheckIcon });
    if (row.status === "running") return /* @__PURE__ */ jsx10(SpinnerRing, { active: true, children: row.step });
    return row2 === "pending" ? /* @__PURE__ */ jsx10(SpinnerRing, { children: row.step }) : row2 === "failed" ? /* @__PURE__ */ jsx10(Badge, { tone: "red", children: XIcon }) : /* @__PURE__ */ jsx10(Badge, { tone: "green", children: CheckIcon });
  };
  const pillFor = (row) => {
    if (row.status === "blocked") return /* @__PURE__ */ jsx10("span", { className: "inline-flex h-5.5 items-center rounded-full bg-inset px-2 text-[11.5px] text-ink-2", children: copy.blocked });
    if (row.status === "failed") return /* @__PURE__ */ jsx10("span", { className: "inline-flex h-5.5 items-center rounded-full bg-red-tint px-2 text-[11.5px] text-red", children: "Failed" });
    if (row.status === "done")
      return /* @__PURE__ */ jsx10("span", { className: "inline-flex h-5.5 items-center rounded-full bg-green-tint px-2 text-[11.5px] font-medium text-green", children: copy.completed });
    if (row.status === "running") return null;
    return row2 === "failed" ? /* @__PURE__ */ jsxs8("span", { className: "inline-flex h-5.5 items-center gap-1.5 rounded-full bg-red-tint px-2 text-[11.5px] font-medium text-red", style: { animation: "fade-in 200ms ease-out both" }, children: [
      copy.failed,
      " ",
      /* @__PURE__ */ jsx10("span", { style: { animation: reducedMotion ? "none" : "spin 1.2s linear infinite" }, className: "flex", children: RetryIcon })
    ] }) : row2 === "done" ? /* @__PURE__ */ jsx10("span", { className: "inline-flex h-5.5 items-center gap-1.5 rounded-full bg-green-tint px-2 text-[11.5px] font-medium text-green", style: { animation: "fade-in 200ms ease-out both" }, children: copy.completed }) : null;
  };
  const list = variant === "List";
  return /* @__PURE__ */ jsx10(
    "div",
    {
      "data-reduced-motion": reducedMotion || void 0,
      className: `flex w-full max-w-110 flex-col ${list ? "gap-0 self-start overflow-hidden rounded-card bg-surface shadow-card" : "min-h-[196px] gap-2"}${className ? ` ${className}` : ""}`,
      children: rows.map((row, i) => {
        const open = manualOpen[row.key] ?? (row.status === "running" && tick === 2);
        return /* @__PURE__ */ jsxs8(
          "div",
          {
            className: `self-stretch overflow-hidden transition-[border-radius,background-color] duration-300 hover:bg-inset ${list ? "border-b border-line last:border-0" : "bg-surface shadow-card"}`,
            style: {
              borderRadius: list ? 0 : open ? 14 : 22,
              animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both`
            },
            children: [
              /* @__PURE__ */ jsxs8(
                "button",
                {
                  type: "button",
                  "aria-expanded": open,
                  onClick: () => {
                    setManualOpen((current) => ({ ...current, [row.key]: !open }));
                    onToggleRow?.(row.key, !open);
                  },
                  "aria-label": `${row.label}: ${row.status === "sequence" ? row2 : row.status}`,
                  className: "flex h-11 w-full items-center gap-2.5 px-2.5 text-left",
                  children: [
                    /* @__PURE__ */ jsx10("span", { className: "flex size-6 shrink-0 items-center justify-center", children: badgeFor(row) }),
                    /* @__PURE__ */ jsx10("span", { className: "min-w-0 flex-1 truncate text-[13px] font-medium text-ink", children: row.label }),
                    /* @__PURE__ */ jsx10("span", { className: "text-[12.5px] text-ink-2 tabular-nums", children: row.amount }),
                    pillFor(row),
                    /* @__PURE__ */ jsx10(
                      "span",
                      {
                        "aria-hidden": "true",
                        className: "-ml-2 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3",
                        children: /* @__PURE__ */ jsx10(
                          "svg",
                          {
                            width: "15",
                            height: "15",
                            viewBox: "0 0 24 24",
                            fill: "none",
                            stroke: "currentColor",
                            strokeWidth: "2.2",
                            strokeLinecap: "round",
                            strokeLinejoin: "round",
                            className: "transition-transform duration-300",
                            style: { transform: open ? "rotate(180deg)" : "rotate(0)" },
                            children: /* @__PURE__ */ jsx10("path", { d: "M6 9l6 6 6-6" })
                          }
                        )
                      }
                    )
                  ]
                }
              ),
              /* @__PURE__ */ jsx10(
                "div",
                {
                  inert: !open,
                  className: "grid transition-[grid-template-rows,opacity] duration-300",
                  style: {
                    gridTemplateRows: open ? "1fr" : "0fr",
                    opacity: open ? 1 : 0,
                    transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)"
                  },
                  children: /* @__PURE__ */ jsx10("div", { className: "overflow-hidden", children: /* @__PURE__ */ jsxs8("div", { className: "mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5", children: [
                    /* @__PURE__ */ jsx10("span", { "aria-hidden": true, className: "mx-auto h-full w-px bg-line" }),
                    /* @__PURE__ */ jsxs8("div", { className: "flex flex-col gap-1.5", children: [
                      row.details.map((d, j) => /* @__PURE__ */ jsxs8(
                        "div",
                        {
                          className: "flex items-center justify-between",
                          style: open ? { animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${120 + j * 100}ms both` } : void 0,
                          children: [
                            /* @__PURE__ */ jsx10("span", { className: "text-[12px] text-ink-2", children: d.label }),
                            /* @__PURE__ */ jsx10("span", { className: "font-mono text-[11.5px] text-ink-3 tabular-nums", children: d.meta })
                          ]
                        },
                        d.label
                      )),
                      row.status === "failed" && onRetry && /* @__PURE__ */ jsx10("button", { type: "button", onClick: () => onRetry(row.key), className: "w-fit rounded-control bg-field px-2 py-1 text-[12px] text-ink", children: "Retry task" })
                    ] })
                  ] }) })
                }
              )
            ]
          },
          row.key
        );
      })
    }
  );
}

// src/components/primitives/ChatComposer.tsx
import { useEffect as useEffect9, useRef as useRef7, useState as useState10 } from "react";
import { jsx as jsx11, jsxs as jsxs9 } from "react/jsx-runtime";
var MESSAGES = [
  { label: "Read applications", sub: "2 records", time: "4s", body: "Leah and Owen both included integration examples." },
  { label: "Prepared review", sub: "Iris", time: "2s", body: "Both are ready for Maya\u2019s review. Nothing has been sent.", details: [{ label: "Admission", value: "Maya reviews" }, { label: "Access", value: "Alex confirms" }] }
];
var SUGGESTIONS = ["Applications", "Prospects"];
var DEFAULT_LABELS5 = {
  initialPrompt: "Screen the new partner applications.",
  placeholder: "Ask Iris, or mention context with @"
};
function Section({ label, sub, time, body, details, resolving }) {
  const reducedMotion = useReducedMotion();
  return /* @__PURE__ */ jsxs9(
    "div",
    {
      className: "flex w-full flex-col gap-1.5 transition-[opacity,filter,transform] duration-400",
      style: { opacity: resolving && !reducedMotion ? 0.55 : 1, filter: resolving && !reducedMotion ? "blur(0.5px)" : "blur(0)", transform: resolving && !reducedMotion ? "scale(0.985)" : "scale(1)", transformOrigin: "top left", transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)", animation: reducedMotion ? "none" : "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" },
      children: [
        /* @__PURE__ */ jsxs9("div", { className: "flex flex-wrap items-center gap-1 text-[12px] leading-[1.3]", children: [
          /* @__PURE__ */ jsx11("span", { className: "font-medium text-ink", children: label }),
          /* @__PURE__ */ jsx11("span", { className: "text-ink-2", children: sub }),
          /* @__PURE__ */ jsxs9("span", { className: "text-ink", children: [
            "for ",
            time
          ] })
        ] }),
        /* @__PURE__ */ jsx11("p", { className: "whitespace-pre-line text-[13px] leading-normal text-ink", children: body }),
        details && /* @__PURE__ */ jsx11("dl", { className: "flex flex-col gap-1 rounded-control bg-field px-2 py-1.5 text-[12px]", children: details.map((item) => /* @__PURE__ */ jsxs9("div", { className: "flex justify-between gap-3", children: [
          /* @__PURE__ */ jsx11("dt", { className: "text-ink-2", children: item.label }),
          /* @__PURE__ */ jsx11("dd", { className: "text-ink", children: item.value })
        ] }, item.label)) })
      ]
    }
  );
}
function ChatComposer({
  messages = MESSAGES,
  suggestions = SUGGESTIONS,
  labels,
  onSend,
  onTabChange,
  onAction,
  sessionMessages,
  sessionPrompts,
  autoplay = false
} = {}) {
  const reducedMotion = useReducedMotion();
  const l = { ...DEFAULT_LABELS5, ...labels };
  const [extraTabs, setExtraTabs] = useState10([]);
  const tabs = [...suggestions, ...extraTabs];
  const [tab, setTab] = useState10(suggestions[0] ?? "Applications");
  const [threads, setThreads] = useState10(() => {
    if (!autoplay) return {};
    const session = suggestions[0] ?? "Applications";
    const firstReplies = sessionMessages?.[session] ?? messages;
    return { [session]: { phase: reducedMotion ? "done" : "sent", draft: "", submitted: sessionPrompts?.[session] ?? l.initialPrompt, visible: reducedMotion ? firstReplies.length : 0, replies: firstReplies } };
  });
  const replies = sessionMessages?.[tab] ?? messages;
  const initial = { phase: "done", draft: "", submitted: sessionPrompts?.[tab] ?? l.initialPrompt, visible: replies.length, replies };
  const thread = threads[tab] ?? initial;
  const { phase, draft, submitted, visible } = thread;
  const busy = phase === "sent" || phase === "reply";
  const inputRef = useRef7(null);
  const timerRef = useRef7(null);
  const [feedback, setFeedback] = useState10("");
  const feedbackTimer = useRef7(null);
  const update = (patch) => setThreads((current) => ({ ...current, [tab]: { ...current[tab] ?? initial, ...patch } }));
  useEffect9(() => {
    if (!busy) return;
    if (reducedMotion) {
      update({ phase: "done", visible: thread.replies.length });
      return;
    }
    const delay = phase === "sent" ? 500 : visible === 1 ? 1400 : 1200;
    timerRef.current = setTimeout(() => {
      setThreads((current) => {
        const active = current[tab];
        if (!active || active.phase !== "sent" && active.phase !== "reply") return current;
        return { ...current, [tab]: active.visible < active.replies.length ? { ...active, phase: "reply", visible: active.visible + 1 } : { ...active, phase: "done" } };
      });
    }, delay);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, visible, tab, reducedMotion, busy, thread.replies.length]);
  useEffect9(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);
  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    update({ phase: reducedMotion ? "done" : "sent", submitted: text, draft: "", visible: reducedMotion ? replies.length : 0, replies });
    onSend?.(text);
  };
  const stop = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    update({ phase: "stopped" });
    onAction?.("stop");
    inputRef.current?.focus();
  };
  const act = async (action) => {
    if (action === "new") {
      const name = `Session ${extraTabs.length + suggestions.length + 1}`;
      setExtraTabs((current) => [...current, name]);
      setThreads((current) => ({ ...current, [name]: { phase: "idle", draft: "", submitted: "", visible: 0, replies } }));
      setTab(name);
      inputRef.current?.focus();
    } else if (action === "copy") {
      try {
        await navigator.clipboard.writeText(thread.replies.slice(0, visible).map((message) => [message.body, ...message.details?.map((item) => `${item.label}: ${item.value}`) ?? []].join("\n")).join("\n\n"));
        setFeedback("Response copied");
      } catch {
        setFeedback("Couldn\u2019t copy. Select the response to copy it.");
      }
    } else {
      setFeedback("Ready to add to Collective");
    }
    onAction?.(action);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(""), 2200);
  };
  const actions = [
    { action: "new", label: "New session", icon: /* @__PURE__ */ jsx11("path", { d: "M12 5v14M5 12h14" }) },
    { action: "copy", label: "Copy response", icon: /* @__PURE__ */ jsxs9("g", { children: [
      /* @__PURE__ */ jsx11("rect", { x: "8", y: "8", width: "12", height: "12", rx: "2" }),
      /* @__PURE__ */ jsx11("path", { d: "M5 15H4V4h11v1" })
    ] }) },
    { action: "collective", label: "Add to Collective", icon: /* @__PURE__ */ jsx11("g", { children: /* @__PURE__ */ jsx11("path", { d: "m12 3-9 5v9l9 5 9-5V8zM3 8l9 5 9-5M12 13v9" }) }) }
  ];
  return /* @__PURE__ */ jsxs9("div", { "data-reduced-motion": reducedMotion || void 0, className: "flex h-[288px] w-full max-w-95 flex-col self-start overflow-hidden rounded-[14px] bg-surface shadow-card", children: [
    /* @__PURE__ */ jsxs9("div", { className: "flex shrink-0 items-center justify-between gap-1 border-b border-line p-1.5", children: [
      /* @__PURE__ */ jsx11("div", { className: "flex min-w-0 items-center overflow-x-auto", "aria-label": "Sessions", children: tabs.map((item) => /* @__PURE__ */ jsx11("button", { type: "button", "aria-pressed": tab === item, onClick: () => {
        setTab(item);
        onTabChange?.(item);
      }, className: `shrink-0 rounded-[6px] px-2 py-[3px] text-[13px] text-ink transition-[background-color,opacity] duration-100 ${tab === item ? "bg-field" : "opacity-50 hover:opacity-75"}`, children: item }, item)) }),
      /* @__PURE__ */ jsx11("div", { className: "flex shrink-0 items-center gap-1", children: actions.map(({ action, label, icon }) => /* @__PURE__ */ jsx11("button", { type: "button", "aria-label": label, title: label, disabled: action !== "new" && !visible, onClick: () => void act(action), className: "flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink-2 disabled:opacity-30", children: /* @__PURE__ */ jsx11("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: icon }) }, action)) })
    ] }),
    /* @__PURE__ */ jsxs9("div", { className: "flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pt-2.5 pb-1", "aria-label": `${tab} conversation`, "aria-busy": busy, children: [
      phase !== "idle" && /* @__PURE__ */ jsx11("div", { className: "flex justify-end pl-14", children: /* @__PURE__ */ jsx11("div", { className: "rounded-xl bg-field px-3 py-1.5 text-[13px] leading-[1.4] text-ink transition-[opacity,transform] duration-300", style: { animation: reducedMotion ? "none" : "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }, children: submitted }, submitted) }),
      thread.replies.slice(0, visible).map((message, index) => /* @__PURE__ */ jsx11(Section, { ...message, resolving: phase === "reply" && visible > 1 && index === visible - 1 }, `${submitted}-${index}`)),
      phase === "sent" && /* @__PURE__ */ jsx11("span", { role: "status", className: "text-[12px] text-ink-2", style: { animation: reducedMotion ? "none" : "shimmer-text 1.4s linear infinite" }, children: "Iris is checking the context\u2026" }),
      phase === "stopped" && /* @__PURE__ */ jsx11("span", { role: "status", className: "text-[12px] text-ink-2", children: "Stopped. Saved replies remain here." }),
      /* @__PURE__ */ jsx11("span", { role: "status", className: "sr-only", children: feedback })
    ] }),
    /* @__PURE__ */ jsx11("div", { className: "mt-auto shrink-0 p-1.5", children: /* @__PURE__ */ jsxs9("div", { role: "presentation", onClick: () => inputRef.current?.focus(), className: "flex cursor-text flex-col gap-2 rounded-control border border-line bg-field p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow] duration-150 focus-within:border-line-strong", children: [
      /* @__PURE__ */ jsx11("input", { ref: inputRef, value: draft, onChange: (event) => update({ draft: event.target.value }), onKeyDown: (event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          send();
        }
      }, placeholder: l.placeholder, "aria-label": "Chat prompt", className: "min-h-4.5 bg-transparent text-[13px] leading-[1.4] text-ink outline-none placeholder:text-ink-3" }),
      /* @__PURE__ */ jsx11("div", { className: "flex items-center justify-end", children: /* @__PURE__ */ jsx11("button", { type: "button", "aria-label": busy ? "Stop response" : "Send", disabled: !busy && !draft.trim(), onClick: busy ? stop : send, className: "flex size-7 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96]", style: { background: busy || draft.trim() ? "var(--accent)" : "var(--line-strong)", color: "var(--ink)" }, children: /* @__PURE__ */ jsx11("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.4", strokeLinecap: "round", strokeLinejoin: "round", children: busy ? /* @__PURE__ */ jsx11("rect", { x: "6", y: "6", width: "12", height: "12", rx: "2", fill: "currentColor" }) : /* @__PURE__ */ jsx11("path", { d: "M12 19V5M5 12l7-7 7 7" }) }) }) })
    ] }) })
  ] });
}

// src/components/primitives/PromptBar.tsx
import { useEffect as useEffect10, useLayoutEffect as useLayoutEffect3, useRef as useRef8, useState as useState11 } from "react";
import { createShader, playSweep, accentChain } from "glimm";
import { jsx as jsx12, jsxs as jsxs10 } from "react/jsx-runtime";
var HERMES_PRISM = accentChain(["#1A135D", "#5458AC", "#C6C3DA", "#F6F4FF", "#827BDE", "#302888"]);
function Icon({ children, size = 15, strokeWidth = 1.8 }) {
  return /* @__PURE__ */ jsx12("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children });
}
var GLYPHS = {
  clip: /* @__PURE__ */ jsx12("path", { d: "m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" }),
  chart: /* @__PURE__ */ jsx12("path", { d: "M4 20V10M10 20V4M16 20v-7M22 20H2" }),
  layers: /* @__PURE__ */ jsxs10("g", { children: [
    /* @__PURE__ */ jsx12("path", { d: "M12 2 2 7l10 5 10-5-10-5z" }),
    /* @__PURE__ */ jsx12("path", { d: "M2 17l10 5 10-5M2 12l10 5 10-5" })
  ] }),
  globe: /* @__PURE__ */ jsxs10("g", { children: [
    /* @__PURE__ */ jsx12("circle", { cx: "12", cy: "12", r: "10" }),
    /* @__PURE__ */ jsx12("path", { d: "M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" })
  ] })
};
var BRANDS = {
  figma: /* @__PURE__ */ jsxs10("svg", { width: "11", height: "16", viewBox: "0 0 38 57", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx12("path", { d: "M9.5 57A9.5 9.5 0 0 0 19 47.5V38H9.5a9.5 9.5 0 0 0 0 19z", fill: "#0ACF83" }),
    /* @__PURE__ */ jsx12("path", { d: "M0 28.5A9.5 9.5 0 0 1 9.5 19H19v19H9.5A9.5 9.5 0 0 1 0 28.5z", fill: "#A259FF" }),
    /* @__PURE__ */ jsx12("path", { d: "M0 9.5A9.5 9.5 0 0 1 9.5 0H19v19H9.5A9.5 9.5 0 0 1 0 9.5z", fill: "#F24E1E" }),
    /* @__PURE__ */ jsx12("path", { d: "M19 0h9.5a9.5 9.5 0 1 1 0 19H19V0z", fill: "#FF7262" }),
    /* @__PURE__ */ jsx12("path", { d: "M38 28.5a9.5 9.5 0 1 1-19 0 9.5 9.5 0 0 1 19 0z", fill: "#1ABCFE" })
  ] }),
  slack: /* @__PURE__ */ jsxs10("svg", { width: "15", height: "15", viewBox: "0 0 127 127", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx12("path", { d: "M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z", fill: "#E01E5A" }),
    /* @__PURE__ */ jsx12("path", { d: "M47 27.2c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.7 39.7.8 47 .8c7.3 0 13.2 5.9 13.2 13.2v13.2H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.3.7 54.4.7 47.1c0-7.3 5.9-13.2 13.2-13.2H47z", fill: "#36C5F0" }),
    /* @__PURE__ */ jsx12("path", { d: "M99.9 47.1c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V47.1zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.9C66.9 6.6 72.8.7 80.1.7c7.3 0 13.2 5.9 13.2 13.2v33.2z", fill: "#2EB67D" }),
    /* @__PURE__ */ jsx12("path", { d: "M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z", fill: "#ECB22E" })
  ] }),
  gmail: /* @__PURE__ */ jsxs10("svg", { width: "15", height: "12", viewBox: "0 0 256 193", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx12("path", { d: "M58.182 192.05V93.14L27.507 65.077 0 49.504v125.091c0 9.658 7.825 17.455 17.455 17.455h40.727Z", fill: "#4285F4" }),
    /* @__PURE__ */ jsx12("path", { d: "M197.818 192.05h40.727c9.659 0 17.455-7.826 17.455-17.455V49.505l-31.156 17.837-27.026 25.798v98.91Z", fill: "#34A853" }),
    /* @__PURE__ */ jsx12("path", { d: "m58.182 93.14-4.174-38.647 4.174-36.989L128 69.868l69.818-52.364 4.669 34.992-4.669 40.644L128 145.504 58.182 93.14Z", fill: "#EA4335" }),
    /* @__PURE__ */ jsx12("path", { d: "M197.818 17.504V93.14L256 49.504V26.231c0-21.585-24.64-33.89-41.89-20.945l-16.292 12.218Z", fill: "#FBBC04" }),
    /* @__PURE__ */ jsx12("path", { d: "m0 49.504 26.759 20.07L58.182 93.14V17.504L41.89 5.286C24.61-7.66 0 4.646 0 26.23v23.273Z", fill: "#C5221F" })
  ] })
};
var SOURCES2 = [
  { key: "attach", name: "Attach files", desc: "From your device", glyph: "clip", attach: true },
  { key: "program", name: "Partner program", desc: "Criteria and guides", glyph: "chart" },
  { key: "applications", name: "Applications", desc: "Submitted evidence", glyph: "layers" },
  { key: "web", name: "Web search", desc: "Public sources", glyph: "globe" },
  { key: "figma", name: "Figma", desc: "Design-to-code workflows", brand: "figma" },
  { key: "slack", name: "Slack", desc: "Partner feedback", brand: "slack" },
  { key: "gmail", name: "Gmail", desc: "Drafts and threads", brand: "gmail" }
];
var COMMANDS = [
  { key: "screen", name: "/screen", desc: "Check application evidence" },
  { key: "research", name: "/research", desc: "Find potential partners" },
  { key: "draft", name: "/draft", desc: "Prepare outreach for review" },
  { key: "summarize", name: "/summarize", desc: "Summarize this session" },
  { key: "skill", name: "/skill", desc: "Find a shared skill" }
];
var MODELS = [
  { key: "deepseek-v4.1-flash", name: "DeepSeek 4.1 Flash", tag: "Default" },
  { key: "sonnet-4.6", name: "Sonnet 4.6", tag: "" },
  { key: "gpt-5.5", name: "GPT-5.5", tag: "" }
];
var FILES = ["partner-criteria.pdf", "applications.csv", "onboarding-guide.pdf"];
var DICTATION = "Find five potential partners and prepare a shortlist for my review.";
var AUTO_STEPS = [
  { draft: "", connect: false, model: "deepseek-v4.1-flash", hold: 1100 },
  { draft: "@", active: 0, hold: 900 },
  { draft: "@", active: 1, hold: 620 },
  { draft: "@", active: 4, hold: 620 },
  { draft: "@", active: 6, hold: 700 },
  { draft: "@", active: 6, connect: true, hold: 1e3 },
  { draft: "", hold: 700 },
  { draft: "/", active: 0, hold: 900 },
  { draft: "/", active: 1, hold: 620 },
  { draft: "/", active: 3, hold: 1e3 },
  { draft: "", hold: 800 },
  // open the model picker and upgrade to the flagship → rainbow sweep
  { draft: "", modelOpen: true, hold: 1200 },
  { draft: "", model: "deepseek-v4.1-flash", hold: 2400 },
  { draft: "", hold: 900 }
];
function parseToken(draft) {
  const match = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!match) return null;
  return {
    kind: match[2] === "@" ? "at" : "slash",
    query: match[3].toLowerCase(),
    start: match.index + match[1].length
  };
}
function PromptBar({
  variant = "Rounded",
  demo = false,
  tall = false,
  placeholder,
  onSend,
  sources = SOURCES2,
  commands = COMMANDS,
  models = MODELS,
  initialModel,
  runtime = "Cloud",
  onRuntimeChange,
  onModelChange,
  onAttach,
  onDictate
}) {
  const reduce = useReducedMotion();
  const pill = variant === "Pill";
  const [execution, setExecution] = useState11(runtime);
  const [dictationError, setDictationError] = useState11("");
  useEffect10(() => setExecution(runtime), [runtime]);
  const [draft, setDraft] = useState11("");
  const [dismissed, setDismissed] = useState11(false);
  const [plusOpen, setPlusOpen] = useState11(false);
  const [modelOpen, setModelOpen] = useState11(false);
  const [model, setModel] = useState11(models.find((m) => m.key === initialModel) ?? models[0] ?? MODELS[0]);
  const [attachments, setAttachments] = useState11([]);
  const [connected, setConnected] = useState11(false);
  const [active, setActive] = useState11(0);
  const [listening, setListening] = useState11(false);
  const [auto, setAuto] = useState11(demo && !reduce);
  const [autoStep, setAutoStep] = useState11(0);
  const [expanded, setExpanded] = useState11(false);
  const wide = expanded || tall;
  const [rowBox, setRowBox] = useState11(null);
  const [engaged, setEngaged] = useState11(false);
  const [modelBox, setModelBox] = useState11(null);
  const [modelHovered, setModelHovered] = useState11(null);
  const [modelMenuLeft, setModelMenuLeft] = useState11(0);
  const [modelMenuBottom, setModelMenuBottom] = useState11(0);
  const composerAnchorRef = useRef8(null);
  const controlsRef = useRef8(null);
  const inputRef = useRef8(null);
  const fileRef = useRef8(null);
  const rootRef = useRef8(null);
  const sweepRef = useRef8(null);
  const dictationGeneration = useRef8(0);
  const measureRef = useRef8(null);
  const modelRef = useRef8(null);
  const rowRefs = useRef8([]);
  const modelRowRefs = useRef8([]);
  const glimmRef = useRef8(null);
  const shaderRef = useRef8(null);
  const sweepingRef = useRef8(false);
  const takeOver = (event) => {
    setAuto(false);
    if (auto && event.target === inputRef.current) setDraft("");
  };
  const token = dismissed ? null : parseToken(draft);
  const menu = plusOpen ? "at" : token?.kind ?? null;
  const query = plusOpen ? "" : token?.query ?? "";
  const rows = menu === "at" ? sources.filter((s) => s.name.toLowerCase().includes(query)) : menu === "slash" ? commands.filter((c) => c.name.slice(1).startsWith(query)) : [];
  useEffect10(() => {
    setActive(0);
    setEngaged(false);
  }, [menu, query]);
  useLayoutEffect3(() => {
    const target = rowRefs.current[active];
    if (target) setRowBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [menu, query, active, connected, rows.length]);
  const modelIndex = models.findIndex((m) => m.key === model.key);
  useLayoutEffect3(() => {
    if (!modelOpen) return;
    const target = modelRowRefs.current[modelHovered ?? modelIndex];
    if (target) setModelBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [modelOpen, modelHovered, modelIndex]);
  useLayoutEffect3(() => {
    if (!modelOpen || !composerAnchorRef.current || !modelRef.current) return;
    const anchorRect = composerAnchorRef.current.getBoundingClientRect();
    const triggerRect = modelRef.current.getBoundingClientRect();
    setModelMenuLeft(Math.max(0, Math.min(triggerRect.left - anchorRect.left, anchorRect.width - 256)));
    setModelMenuBottom(anchorRect.bottom - triggerRect.top + 8);
  }, [modelOpen, wide, model.name]);
  useEffect10(() => {
    if (!modelOpen) setModelHovered(null);
  }, [modelOpen]);
  const makeShader = () => {
    const canvas = glimmRef.current;
    if (!canvas || reduce) return null;
    return createShader({ canvas, palette: HERMES_PRISM, direction: "ltr", bandTight: 10, swellAmount: 0.85 });
  };
  useEffect10(() => {
    if (reduce) setAuto(false);
    return () => {
      sweepRef.current?.cancel();
      sweepRef.current = null;
      shaderRef.current?.destroy();
      shaderRef.current = null;
      sweepingRef.current = false;
      dictationGeneration.current += 1;
    };
  }, [reduce]);
  const celebrate = () => {
    if (reduce) return;
    sweepRef.current?.cancel();
    shaderRef.current?.destroy();
    const shader = makeShader();
    shaderRef.current = shader;
    if (!shader) return;
    sweepingRef.current = true;
    const sweep = playSweep(shader, {
      palette: HERMES_PRISM,
      direction: "ltr",
      sweepMs: 570,
      outroMs: 80,
      peakAlpha: 1.3,
      bandTight: 10,
      brightness: 1.4,
      swellAmount: 1,
      waveSpeed: 1.8,
      easing: "easeOutExpo"
    });
    sweepRef.current = sweep;
    sweep.done.finally(() => {
      if (sweepRef.current === sweep) {
        sweepingRef.current = false;
        sweepRef.current = null;
      }
    });
  };
  const selectModel = (next) => {
    setModel(next);
    setModelOpen(false);
    onModelChange?.(next);
    if (next.key === models[0]?.key) celebrate();
  };
  useEffect10(() => {
    if (!auto || reduce) return;
    const step = AUTO_STEPS[autoStep % AUTO_STEPS.length];
    setDraft(step.draft);
    if (step.active !== void 0) setActive(step.active);
    if (step.connect !== void 0) setConnected(step.connect);
    if (step.modelOpen !== void 0) setModelOpen(step.modelOpen);
    if (step.model) {
      const next = models.find((m) => m.key === step.model);
      if (next) selectModel(next);
    }
    const t = setTimeout(() => setAutoStep((s) => s + 1), step.hold);
    return () => clearTimeout(t);
  }, [auto, autoStep, reduce]);
  useEffect10(() => {
    if (!listening || onDictate) return;
    const t = setTimeout(() => {
      setDraft((current) => current ? `${current.trimEnd()} ${DICTATION}` : DICTATION);
      setListening(false);
      inputRef.current?.focus();
    }, 2200);
    return () => clearTimeout(t);
  }, [listening, onDictate]);
  useLayoutEffect3(() => {
    const input = inputRef.current;
    const controls = controlsRef.current;
    const measure = measureRef.current;
    const modelButton = modelRef.current;
    if (!input || !controls || !measure || !modelButton) return;
    const fixedControlsWidth = 28 * 3 + modelButton.offsetWidth;
    const inlineGaps = 4 * 4;
    const inlineInputWidth = controls.clientWidth - fixedControlsWidth - inlineGaps;
    const needsFullWidth = draft.includes("\n") || measure.offsetWidth + 8 > inlineInputWidth;
    if (needsFullWidth !== expanded) {
      setExpanded(needsFullWidth);
    }
    const minHeight = 28;
    const maxHeight = 100;
    input.style.height = "0px";
    const contentHeight = input.scrollHeight;
    input.style.height = `${Math.min(Math.max(contentHeight, minHeight), maxHeight)}px`;
    input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [draft, expanded]);
  useEffect10(() => {
    if (!modelOpen && !plusOpen) return;
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setModelOpen(false);
        setPlusOpen(false);
      }
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setModelOpen(false);
        setPlusOpen(false);
        inputRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [modelOpen, plusOpen]);
  const closeMenus = () => {
    setPlusOpen(false);
    setModelOpen(false);
  };
  const pick = (row) => {
    const source = sources.find((s) => s.key === row.key);
    if (source?.attach) {
      if (demo) setAttachments((current) => [...current, FILES[current.length % FILES.length]]);
      else fileRef.current?.click();
      if (token) setDraft(draft.slice(0, token.start));
    } else if (menu === "at") {
      setDraft(`${token ? draft.slice(0, token.start) : draft}@${row.name} `);
    } else {
      setDraft(`${token ? draft.slice(0, token.start) : draft}${row.name} `);
    }
    setPlusOpen(false);
    setDismissed(false);
    inputRef.current?.focus();
  };
  const canSend = draft.trim().length > 0 || attachments.length > 0;
  const send = () => {
    if (!canSend) return;
    onSend?.(draft.trim(), { text: draft.trim(), attachments: [...attachments], model, runtime: execution });
    setDraft("");
    setAttachments([]);
    closeMenus();
  };
  return /* @__PURE__ */ jsxs10(
    "div",
    {
      "data-promptbar": true,
      ref: rootRef,
      className: demo ? "flex min-h-[384px] w-full max-w-105 flex-col justify-end pb-8" : "w-full",
      onPointerDownCapture: takeOver,
      onKeyDownCapture: takeOver,
      children: [
        /* @__PURE__ */ jsx12("input", { ref: fileRef, type: "file", multiple: true, hidden: true, onChange: (event) => {
          const files = Array.from(event.target.files ?? []);
          setAttachments((current) => [...current, ...files.map((file) => file.name)]);
          onAttach?.(files);
          event.currentTarget.value = "";
        } }),
        /* @__PURE__ */ jsxs10("div", { ref: composerAnchorRef, className: "relative", children: [
          menu && /* @__PURE__ */ jsxs10(
            "div",
            {
              onMouseLeave: () => setEngaged(false),
              className: "absolute inset-x-0 bottom-full z-10 mb-2 rounded-[10px] bg-surface p-1 shadow-raised",
              style: { animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom center" },
              children: [
                /* @__PURE__ */ jsx12(
                  "span",
                  {
                    "aria-hidden": true,
                    className: "pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover",
                    style: {
                      top: rowBox?.top ?? 0,
                      height: rowBox?.height ?? 0,
                      opacity: rowBox && engaged && rows.length > 0 ? 1 : 0,
                      transition: "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease"
                    }
                  }
                ),
                rows.map((row, i) => {
                  const source = menu === "at" ? sources.find((s) => s.key === row.key) : void 0;
                  return /* @__PURE__ */ jsxs10(
                    "button",
                    {
                      type: "button",
                      ref: (el) => {
                        rowRefs.current[i] = el;
                      },
                      onMouseDown: (event) => event.preventDefault(),
                      onMouseEnter: () => {
                        setActive(i);
                        setEngaged(true);
                      },
                      onClick: () => pick(row),
                      className: "relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2 text-left",
                      children: [
                        source && /* @__PURE__ */ jsx12("span", { className: "flex size-5.5 shrink-0 items-center justify-center text-ink-2", children: source.brand ? BRANDS[source.brand] : /* @__PURE__ */ jsx12(Icon, { size: 15, children: GLYPHS[source.glyph ?? "clip"] }) }),
                        /* @__PURE__ */ jsx12("span", { className: "shrink-0 text-[12.5px] font-medium text-ink", children: row.name }),
                        /* @__PURE__ */ jsx12("span", { className: "min-w-0 flex-1 truncate text-[12px] text-ink-3", children: row.desc }),
                        source?.connect && /* @__PURE__ */ jsx12(
                          "span",
                          {
                            role: "button",
                            tabIndex: -1,
                            onClick: (event) => {
                              event.stopPropagation();
                              setConnected((current) => !current);
                            },
                            className: `shrink-0 text-[12px] font-medium transition-colors duration-100 ${connected ? "text-green" : "text-accent-ink hover:underline"}`,
                            children: connected ? "Connected" : "Connect"
                          }
                        )
                      ]
                    },
                    row.key
                  );
                }),
                rows.length === 0 && /* @__PURE__ */ jsxs10("div", { className: "flex h-9 items-center px-2 text-[12px] text-ink-3", children: [
                  "No matches for \u201C",
                  query,
                  "\u201D"
                ] }),
                /* @__PURE__ */ jsx12("div", { className: "mt-1 border-t border-line px-2 pt-1.5 pb-1 text-[11px] text-ink-3", children: menu === "at" ? "Type to search sources & files" : "Type to search commands" })
              ]
            }
          ),
          modelOpen && /* @__PURE__ */ jsxs10(
            "div",
            {
              onMouseLeave: () => setModelHovered(null),
              className: "absolute z-10 w-64 rounded-[10px] bg-surface p-1 shadow-raised",
              style: { left: modelMenuLeft, bottom: modelMenuBottom, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" },
              children: [
                /* @__PURE__ */ jsx12(
                  "span",
                  {
                    "aria-hidden": true,
                    className: "pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover",
                    style: {
                      top: modelBox?.top ?? 0,
                      height: modelBox?.height ?? 0,
                      opacity: modelBox && modelHovered !== null ? 1 : 0,
                      transition: "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease"
                    }
                  }
                ),
                models.map((m, i) => /* @__PURE__ */ jsxs10(
                  "button",
                  {
                    type: "button",
                    ref: (el) => {
                      modelRowRefs.current[i] = el;
                    },
                    onMouseDown: (event) => event.preventDefault(),
                    onMouseEnter: () => setModelHovered(i),
                    onClick: () => {
                      selectModel(m);
                      inputRef.current?.focus();
                    },
                    className: "relative z-10 flex h-7.5 w-full items-center gap-2 rounded-[6px] px-2 text-left",
                    children: [
                      /* @__PURE__ */ jsx12("span", { className: "min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink", children: m.name }),
                      /* @__PURE__ */ jsx12("span", { className: "shrink-0 text-[11px] text-ink-3", children: m.tag }),
                      /* @__PURE__ */ jsx12("span", { className: `shrink-0 text-ink ${m.key === model.key ? "" : "invisible"}`, children: /* @__PURE__ */ jsx12(Icon, { size: 13, strokeWidth: 2.5, children: /* @__PURE__ */ jsx12("path", { d: "M20 6L9 17l-5-5" }) }) })
                    ]
                  },
                  m.key
                ))
              ]
            }
          ),
          /* @__PURE__ */ jsxs10(
            "div",
            {
              className: `prompt-surface relative isolate flex flex-col overflow-hidden border border-line bg-surface shadow-card ${tall ? "gap-2.5 p-3.5" : "gap-1.5 p-1.5"} ${pill ? attachments.length > 0 || wide ? "rounded-[24px]" : "rounded-full" : tall ? "rounded-[22px]" : "rounded-[14px]"}`,
              children: [
                /* @__PURE__ */ jsx12(
                  "canvas",
                  {
                    ref: glimmRef,
                    "aria-hidden": "true",
                    className: "pointer-events-none absolute inset-0 -z-10 h-full w-full",
                    style: { borderRadius: "inherit" }
                  }
                ),
                /* @__PURE__ */ jsx12(
                  "span",
                  {
                    ref: measureRef,
                    "aria-hidden": "true",
                    className: "pointer-events-none absolute invisible whitespace-pre text-[13px] leading-[18px]",
                    children: draft
                  }
                ),
                attachments.length > 0 && /* @__PURE__ */ jsx12("div", { className: `flex flex-wrap gap-1.5 pt-0.5 ${pill ? "px-1" : "px-0.5"}`, children: attachments.map((file, i) => /* @__PURE__ */ jsxs10(
                  "span",
                  {
                    className: `flex h-6.5 items-center gap-1.5 bg-field py-1 pr-1 pl-1.5 text-[11.5px] text-ink-2 shadow-hairline ${pill ? "rounded-full" : "rounded-chip"}`,
                    style: { animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" },
                    children: [
                      /* @__PURE__ */ jsx12(Icon, { size: 12, children: /* @__PURE__ */ jsxs10("g", { children: [
                        /* @__PURE__ */ jsx12("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }),
                        /* @__PURE__ */ jsx12("path", { d: "M14 2v6h6" })
                      ] }) }),
                      /* @__PURE__ */ jsx12("span", { className: "max-w-36 truncate", children: file }),
                      /* @__PURE__ */ jsx12(
                        "button",
                        {
                          type: "button",
                          "aria-label": `Remove ${file}`,
                          onClick: () => setAttachments((current) => current.filter((_, j) => j !== i)),
                          className: `-my-1 flex size-6 items-center justify-center text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink ${pill ? "rounded-full" : "rounded-[5px]"}`,
                          children: /* @__PURE__ */ jsx12(Icon, { size: 10, strokeWidth: 2.5, children: /* @__PURE__ */ jsx12("path", { d: "M18 6L6 18M6 6l12 12" }) })
                        }
                      )
                    ]
                  },
                  `${file}-${i}`
                )) }),
                /* @__PURE__ */ jsxs10(
                  "div",
                  {
                    ref: controlsRef,
                    className: `grid items-end gap-x-1 gap-y-1.5 ${wide ? "grid-cols-[28px_auto_minmax(0,1fr)_28px_28px]" : "grid-cols-[28px_minmax(0,1fr)_auto_28px_28px]"}`,
                    children: [
                      /* @__PURE__ */ jsx12(
                        "button",
                        {
                          type: "button",
                          "aria-label": "Add attachments and sources",
                          "aria-expanded": plusOpen,
                          onClick: () => {
                            setModelOpen(false);
                            setPlusOpen((current) => !current);
                            inputRef.current?.focus();
                          },
                          className: `flex size-7 shrink-0 items-center justify-center justify-self-start text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.94] ${pill ? "rounded-full" : "rounded-[8px]"} ${plusOpen ? "bg-hover text-ink" : ""} ${wide ? "col-start-1 row-start-2" : "col-start-1 row-start-1"}`,
                          children: /* @__PURE__ */ jsx12(Icon, { size: 16, strokeWidth: 2, children: /* @__PURE__ */ jsx12("path", { d: "M12 5v14M5 12h14" }) })
                        }
                      ),
                      /* @__PURE__ */ jsx12(
                        "textarea",
                        {
                          ref: inputRef,
                          rows: 1,
                          value: draft,
                          onChange: (event) => {
                            setDraft(event.target.value);
                            setDismissed(false);
                            setPlusOpen(false);
                          },
                          onKeyDown: (event) => {
                            if (menu && rows.length > 0) {
                              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                                event.preventDefault();
                                setEngaged(true);
                                setActive((current) => (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
                                return;
                              }
                              if (event.key === "Enter" && !event.shiftKey || event.key === "Tab") {
                                event.preventDefault();
                                pick(rows[active]);
                                return;
                              }
                            }
                            if (event.key === "Escape") {
                              setDismissed(true);
                              closeMenus();
                              return;
                            }
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              send();
                            }
                          },
                          placeholder: listening ? onDictate ? "Listening\u2026" : "Demo dictation\u2026" : placeholder ?? "Ask Iris\u2026",
                          "aria-label": "Prompt",
                          className: `prompt-input ${tall ? "min-h-[68px] px-2 py-2 text-[14px] leading-5" : "min-h-7 px-1 py-[5px] text-[13px] leading-[18px]"} min-w-0 w-full resize-none bg-transparent text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3 ${wide ? "col-span-full col-start-1 row-start-1" : "col-start-2 row-start-1"}`
                        }
                      ),
                      /* @__PURE__ */ jsxs10(
                        "button",
                        {
                          ref: modelRef,
                          type: "button",
                          "aria-expanded": modelOpen,
                          "aria-label": "Choose model",
                          onClick: () => {
                            setPlusOpen(false);
                            setModelOpen((current) => !current);
                          },
                          className: `flex h-7 shrink-0 items-center gap-1 px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink ${pill ? "rounded-full" : "rounded-[8px]"} ${wide ? "col-start-2 row-start-2 justify-self-start" : "col-start-3 row-start-1"}`,
                          children: [
                            model.name,
                            /* @__PURE__ */ jsx12("span", { className: "text-ink-3", children: /* @__PURE__ */ jsx12(Icon, { size: 11, strokeWidth: 2.4, children: /* @__PURE__ */ jsx12("path", { d: "M6 9l6 6 6-6" }) }) })
                          ]
                        }
                      ),
                      /* @__PURE__ */ jsx12(
                        "button",
                        {
                          type: "button",
                          "aria-label": listening ? "Stop dictation" : onDictate ? "Start dictation" : "Try demo dictation",
                          title: onDictate ? "Dictate" : "Demo dictation \u2014 sample text, no microphone",
                          "aria-pressed": listening,
                          onClick: async () => {
                            if (listening) {
                              dictationGeneration.current += 1;
                              setListening(false);
                              return;
                            }
                            setDictationError("");
                            setListening(true);
                            if (!onDictate) return;
                            const generation = ++dictationGeneration.current;
                            try {
                              const text = await onDictate();
                              if (generation === dictationGeneration.current) setDraft((current) => `${current.trimEnd()} ${text}`.trim());
                            } catch {
                              if (generation === dictationGeneration.current) setDictationError("Dictation unavailable. Try typing.");
                            } finally {
                              if (generation === dictationGeneration.current) setListening(false);
                            }
                          },
                          className: `flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-150 active:scale-[0.94] ${pill ? "rounded-full" : "rounded-[8px]"} ${listening ? "bg-accent-tint text-accent-ink" : "text-ink-3 hover:bg-hover hover:text-ink"} ${wide ? "col-start-4 row-start-2" : "col-start-4 row-start-1"}`,
                          children: listening ? /* @__PURE__ */ jsx12("span", { className: "flex h-3.5 items-center gap-[2.5px]", children: [0, 1, 2].map((i) => /* @__PURE__ */ jsx12(
                            "span",
                            {
                              className: "w-[2.5px] rounded-full bg-current",
                              style: { height: "100%", animation: reduce ? "none" : `eq-bounce 900ms ease-in-out ${i * 150}ms infinite` }
                            },
                            i
                          )) }) : /* @__PURE__ */ jsx12(Icon, { size: 15, strokeWidth: 2, children: /* @__PURE__ */ jsxs10("g", { children: [
                            /* @__PURE__ */ jsx12("path", { d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" }),
                            /* @__PURE__ */ jsx12("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" })
                          ] }) })
                        }
                      ),
                      /* @__PURE__ */ jsx12(
                        "button",
                        {
                          type: "button",
                          "aria-label": "Send",
                          disabled: !canSend,
                          onClick: send,
                          className: `flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] ${pill ? "rounded-full" : "rounded-[8px]"} ${wide ? "col-start-5 row-start-2" : "col-start-5 row-start-1"}`,
                          style: {
                            background: canSend ? "var(--ink)" : "var(--line-strong)",
                            color: canSend ? "var(--surface)" : "var(--ink-2)"
                          },
                          children: /* @__PURE__ */ jsx12(Icon, { size: 16, strokeWidth: 2.4, children: /* @__PURE__ */ jsx12("path", { d: "M12 19V5M5 12l7-7 7 7" }) })
                        }
                      )
                    ]
                  }
                )
              ]
            }
          )
        ] }),
        /* @__PURE__ */ jsxs10("div", { className: "mt-2 flex items-center justify-between gap-3 text-[12px] text-ink-3", children: [
          /* @__PURE__ */ jsxs10("button", { type: "button", "aria-label": `Execution: ${execution}. Change runtime`, onClick: () => {
            const next = execution === "Cloud" ? "Local" : "Cloud";
            setExecution(next);
            onRuntimeChange?.(next);
          }, className: "flex items-center gap-1.5 rounded-control px-2 py-1 hover:bg-hover text-ink-2", children: [
            /* @__PURE__ */ jsx12(Icon, { size: 13, children: execution === "Cloud" ? /* @__PURE__ */ jsx12("path", { d: "M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11Z" }) : /* @__PURE__ */ jsx12("path", { d: "M3 4h18v13H3Z M8 21h8 M12 17v4" }) }),
            execution,
            /* @__PURE__ */ jsx12(Icon, { size: 10, children: /* @__PURE__ */ jsx12("path", { d: "m6 9 6 6 6-6" }) })
          ] }),
          listening && !onDictate && /* @__PURE__ */ jsx12("span", { role: "status", children: "Demo dictation \xB7 no microphone" }),
          dictationError && /* @__PURE__ */ jsx12("span", { role: "status", children: dictationError })
        ] })
      ]
    }
  );
}

// src/components/primitives/RecommendationCard.tsx
import { useRef as useRef9, useState as useState12 } from "react";

// src/components/atoms/EntityChip.tsx
import { jsx as jsx13, jsxs as jsxs11 } from "react/jsx-runtime";
function Monogram({
  children,
  color = "#e08a3c",
  className = ""
}) {
  return /* @__PURE__ */ jsx13(
    "span",
    {
      className: `flex size-4 shrink-0 items-center justify-center rounded-full
        text-[9px] font-semibold leading-none text-white ${className}`,
      style: { background: color },
      children
    }
  );
}
function EntityChip({
  name,
  color,
  monogram,
  className = ""
}) {
  return /* @__PURE__ */ jsxs11(
    "span",
    {
      className: `mx-0.5 inline-flex items-center gap-1 rounded-full bg-field
        py-px pl-[3px] pr-1.5 align-middle shadow-hairline ${className}`,
      children: [
        /* @__PURE__ */ jsx13(Monogram, { color, children: monogram ?? name.charAt(0) }),
        /* @__PURE__ */ jsx13("span", { className: "text-[12px] font-medium text-ink", children: name })
      ]
    }
  );
}

// src/components/atoms/ValuePill.tsx
import { jsx as jsx14 } from "react/jsx-runtime";
var TONES2 = {
  neutral: { cls: "bg-field text-ink-2", ring: "var(--shadow-hairline)" },
  green: { cls: "bg-green-tint text-green", ring: "0 0 0 1px color-mix(in oklch, var(--green) 28%, transparent)" },
  orange: { cls: "bg-orange-tint text-orange", ring: "0 0 0 1px color-mix(in oklch, var(--orange) 28%, transparent)" },
  red: { cls: "bg-red-tint text-red", ring: "0 0 0 1px color-mix(in oklch, var(--red) 28%, transparent)" },
  accent: { cls: "bg-accent-tint text-accent-ink", ring: "0 0 0 1px color-mix(in oklch, var(--accent) 28%, transparent)" }
};
function ValuePill({
  children,
  tone = "neutral",
  className = ""
}) {
  const t = TONES2[tone];
  return /* @__PURE__ */ jsx14(
    "span",
    {
      className: `mx-0.5 inline-flex items-center rounded-full px-1.5 py-0
        align-middle text-[12px] font-medium ${t.cls} ${className}`,
      style: { boxShadow: t.ring },
      children
    }
  );
}

// src/components/primitives/RecommendationCard.tsx
import { Fragment as Fragment4, jsx as jsx15, jsxs as jsxs12 } from "react/jsx-runtime";
var DEFAULT_LABELS6 = {
  title: "What should Maya review first?",
  alternatives: "Alternatives",
  otherOptions: "Other reviews",
  accepted: "Review opened"
};
var OPTIONS = [
  {
    key: "high",
    body: /* @__PURE__ */ jsxs12(Fragment4, { children: [
      "Review",
      " ",
      /* @__PURE__ */ jsx15(EntityChip, { name: "Leah" }),
      " ",
      "against ",
      /* @__PURE__ */ jsx15(ValuePill, { tone: "green", children: "3 cited sources" })
    ] }),
    short: "Leah \xB7 Open the screening report",
    signal: 3,
    tone: "var(--green)",
    label: "3 sources cited",
    cta: "Open review",
    ctaVariant: "accent"
  },
  {
    key: "review",
    body: /* @__PURE__ */ jsxs12(Fragment4, { children: [
      "Check ",
      /* @__PURE__ */ jsx15(ValuePill, { children: "Owen\u2019s capacity" }),
      " before Maya decides."
    ] }),
    short: "Owen \xB7 Check the evidence gaps",
    signal: 2,
    tone: "var(--orange)",
    label: "Sources incomplete",
    cta: "Open review",
    ctaVariant: "primary"
  },
  {
    key: "none",
    body: /* @__PURE__ */ jsxs12(Fragment4, { children: [
      "Ask for a ",
      /* @__PURE__ */ jsx15("span", { className: "font-medium text-ink", children: "customer reference" }),
      " in the review notes."
    ] }),
    short: "Both applicants \xB7 Prepare a question",
    signal: 0,
    tone: "var(--ink-3)",
    label: "Impact unverified",
    cta: "Prepare note",
    ctaVariant: "primary"
  }
];
function Meter({ signal, tone }) {
  return /* @__PURE__ */ jsx15("span", { className: "flex items-end gap-0.5", children: [0, 1, 2].map((bar) => /* @__PURE__ */ jsx15(
    "span",
    {
      className: "w-1 rounded-full transition-colors duration-300",
      style: { height: 10, background: bar < signal ? tone : "var(--line-strong)" }
    },
    bar
  )) });
}
function RecommendationCard({
  options = OPTIONS,
  labels,
  onConfirm,
  onSelect
} = {}) {
  const reduce = useReducedMotion();
  const busy = useRef9(false);
  const [pending, setPending] = useState12(false);
  const [error, setError] = useState12("");
  const t = { ...DEFAULT_LABELS6, ...labels };
  const [selected, setSelected] = useState12(0);
  const [open, setOpen] = useState12(false);
  const [accepted, setAccepted] = useState12(false);
  const active = options[selected] ?? options[0];
  if (!active) return null;
  const others = options.map((o, i) => ({ o, i })).filter(({ i }) => i !== selected);
  return /* @__PURE__ */ jsxs12("div", { "data-reduced-motion": reduce, className: "hermes-ui w-full max-w-95 overflow-hidden rounded-card bg-surface shadow-card", children: [
    /* @__PURE__ */ jsxs12("div", { className: "primitive-card-pad", children: [
      /* @__PURE__ */ jsx15("span", { className: "text-[14px] font-medium text-ink", children: t.title }),
      /* @__PURE__ */ jsx15(
        "p",
        {
          className: "mt-1.5 min-h-12 text-[13px] leading-relaxed text-ink-2",
          style: { animation: reduce ? "none" : "fade-in 180ms ease-out both" },
          children: active.body
        },
        active.key
      )
    ] }),
    /* @__PURE__ */ jsx15(
      "div",
      {
        inert: !open,
        className: "grid transition-[grid-template-rows,opacity] duration-300",
        style: {
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)"
        },
        children: /* @__PURE__ */ jsx15("div", { className: "overflow-hidden", children: /* @__PURE__ */ jsxs12("div", { className: "border-t border-line bg-surface px-2 py-2", children: [
          /* @__PURE__ */ jsx15("p", { className: "px-1.5 pb-1 text-[11px] font-medium text-ink-3", children: t.otherOptions }),
          others.map(({ o, i }) => /* @__PURE__ */ jsxs12(
            "button",
            {
              type: "button",
              onClick: () => {
                if (busy.current) return;
                setSelected(i);
                setError("");
                onSelect?.(o);
                setAccepted(false);
              },
              className: "flex w-full items-center gap-2.5 rounded-control px-1.5 py-1.5\n                  text-left transition-colors duration-100 hover:bg-hover",
              children: [
                /* @__PURE__ */ jsx15(Meter, { signal: o.signal, tone: o.tone }),
                /* @__PURE__ */ jsx15("span", { className: "min-w-0 flex-1 truncate text-[12.5px] text-ink", children: o.short }),
                /* @__PURE__ */ jsx15("span", { className: "shrink-0 text-[11px] text-ink-3", children: o.label })
              ]
            },
            o.key
          ))
        ] }) })
      }
    ),
    error && /* @__PURE__ */ jsx15("p", { role: "alert", className: "px-3 text-[12px] text-red", children: error }),
    /* @__PURE__ */ jsxs12("div", { className: "primitive-card-footer flex items-center justify-between gap-3 bg-surface", children: [
      /* @__PURE__ */ jsxs12("span", { className: "flex items-center gap-2", children: [
        /* @__PURE__ */ jsx15(Meter, { signal: active.signal, tone: active.tone }),
        /* @__PURE__ */ jsx15("span", { className: "text-[12.5px] font-medium text-ink-2", children: active.label })
      ] }),
      /* @__PURE__ */ jsxs12("span", { className: "-mr-0.5 flex items-center gap-2", children: [
        /* @__PURE__ */ jsx15(
          Button,
          {
            variant: "secondary",
            size: "sm",
            "aria-expanded": open,
            onClick: () => setOpen((current) => !current),
            className: "px-2.5 text-[12.5px]",
            children: t.alternatives
          }
        ),
        /* @__PURE__ */ jsx15(
          Button,
          {
            variant: accepted ? "success" : active.ctaVariant,
            size: "sm",
            disabled: pending || accepted || !onConfirm,
            onClick: async () => {
              if (busy.current || !onConfirm) return;
              busy.current = true;
              setPending(true);
              setError("");
              try {
                await onConfirm(active);
                setAccepted(true);
              } catch {
                setError("Could not open this. Try again.");
              } finally {
                busy.current = false;
                setPending(false);
              }
            },
            className: "text-[12.5px]",
            children: pending ? "Opening\u2026" : accepted ? t.accepted : active.cta
          }
        )
      ] })
    ] })
  ] });
}

// src/components/primitives/ContextCards.tsx
import { useEffect as useEffect11, useState as useState13 } from "react";
import { jsx as jsx16, jsxs as jsxs13 } from "react/jsx-runtime";
var DEFAULT_LABELS7 = {
  header: "Cited context",
  count: ""
};
var PARTNER_CONTEXT = [
  { title: "Admission review", chars: "Program rule", body: "Iris screens each application against cited criteria. Maya decides admission and the exact role benefits.", source: "Partner criteria v2.md", badge: "MD", tone: "bg-accent" },
  { title: "Verified delivery", chars: "Invoice source", body: "Maya accepted Robin\u2019s October 8 workshop and October 9 resource pack. The fees are $900 and $300.", source: "Delivery statement.pdf", badge: "PDF", tone: "bg-accent" }
];
function ContextCards({
  chunks = PARTNER_CONTEXT,
  labels,
  className,
  onOpenSource
} = {}) {
  const reduce = useReducedMotion();
  const [chipsShown, setChipsShown] = useState13(false);
  const copy = { ...DEFAULT_LABELS7, count: String(chunks.length), ...labels };
  useEffect11(() => {
    if (reduce) {
      setChipsShown(true);
      return;
    }
    const chips = setTimeout(() => setChipsShown(true), 700);
    return () => clearTimeout(chips);
  }, [reduce]);
  return /* @__PURE__ */ jsxs13("div", { "data-reduced-motion": reduce, className: `hermes-ui flex w-full max-w-95 flex-col gap-2${className ? ` ${className}` : ""}`, children: [
    /* @__PURE__ */ jsxs13(
      "div",
      {
        className: "flex items-center gap-2 px-0.5",
        style: { animation: reduce ? "none" : "fade-in 400ms ease-out both" },
        children: [
          /* @__PURE__ */ jsx16("span", { className: "text-[13px] font-semibold text-ink", children: copy.header }),
          /* @__PURE__ */ jsx16("span", { className: "inline-flex h-5 items-center rounded-md bg-inset px-1.5 text-[11.5px] font-medium text-ink-2 shadow-hairline tabular-nums", children: copy.count })
        ]
      }
    ),
    chunks.map((chunk2, i) => /* @__PURE__ */ jsxs13(
      "div",
      {
        className: "overflow-hidden rounded-card bg-surface shadow-card",
        style: {
          animation: reduce ? "none" : `fade-up 400ms cubic-bezier(0.23,1,0.32,1) ${i * 100}ms both`
        },
        children: [
          /* @__PURE__ */ jsxs13("div", { className: "primitive-card-bar flex items-center gap-2.5 border-b border-line", children: [
            /* @__PURE__ */ jsxs13("span", { className: "flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink", children: [
              /* @__PURE__ */ jsx16("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", children: /* @__PURE__ */ jsx16("path", { d: "M4 6h16M4 12h16M4 18h10" }) }),
              /* @__PURE__ */ jsx16("span", { className: "truncate", children: chunk2.title })
            ] }),
            /* @__PURE__ */ jsx16("span", { className: "ml-auto shrink-0 text-[12px] text-ink-3 tabular-nums", children: chunk2.chars })
          ] }),
          /* @__PURE__ */ jsx16("p", { className: "px-3 pt-2 pb-1 text-[12.5px] leading-relaxed text-ink-2", children: chunk2.body }),
          /* @__PURE__ */ jsx16("div", { className: "px-3 pb-3", children: /* @__PURE__ */ jsxs13(
            "button",
            {
              type: "button",
              tabIndex: chipsShown ? 0 : -1,
              disabled: !onOpenSource,
              onClick: () => onOpenSource?.(chunk2),
              className: "inline-flex h-6 items-center gap-1.5 rounded-full bg-inset px-2\n                text-[12px] font-medium text-ink-2 shadow-btn\n                transition-[opacity,transform,background-color] duration-300 hover:bg-hover",
              style: {
                opacity: chipsShown ? 1 : 0,
                transform: chipsShown ? "scale(1)" : "scale(0.95)",
                transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                transitionDelay: `${i * 80}ms`
              },
              children: [
                /* @__PURE__ */ jsx16("span", { className: `flex size-3.5 items-center justify-center rounded-[4px] ${chunk2.tone} text-[7px] font-bold text-white`, children: chunk2.badge }),
                chunk2.source,
                /* @__PURE__ */ jsx16("svg", { width: "9", height: "9", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx16("path", { d: "M7 17L17 7M7 7h10v10" }) })
              ]
            }
          ) })
        ]
      },
      chunk2.title
    ))
  ] });
}

// src/components/primitives/DiffTable.tsx
import { useEffect as useEffect12, useRef as useRef10, useState as useState14 } from "react";
import { Fragment as Fragment5, jsx as jsx17, jsxs as jsxs14 } from "react/jsx-runtime";
function useStage(steps, reduced) {
  const [stage, setStage] = useState14(0);
  useEffect12(() => {
    if (reduced) {
      setStage(steps.length);
      return;
    }
    if (stage >= steps.length) return;
    const t = setTimeout(() => setStage((s) => s + 1), steps[stage]);
    return () => clearTimeout(t);
  }, [stage, steps, reduced]);
  return stage;
}
var STAGE_DELAYS = [180, 260];
var ROWS2 = [
  { key: "order", id: "Evidence order", dept: "Iris", email: "Source order", removed: true },
  { key: "gaps", id: "Gap placement", dept: "Iris", email: "End of review", removed: true },
  { key: "review", id: "Admission", dept: "Maya", email: "Human review", removed: false }
];
var ADDED = { key: "gaps-first", id: "Evidence gaps", dept: "Iris", email: "Lead each review", removed: false };
var DOT = { Iris: "bg-accent", Maya: "bg-ink-3" };
function IncludedMark({ included, tone }) {
  return /* @__PURE__ */ jsx17(
    "span",
    {
      "aria-hidden": true,
      className: `flex size-4.5 shrink-0 items-center justify-center rounded-[5px] transition-[background-color,color,transform] duration-150 ${included ? tone === "red" ? "bg-red text-white" : "bg-green text-white" : "bg-inset text-ink-3 shadow-hairline"}`,
      style: { transform: included ? "scale(1)" : "scale(0.92)" },
      children: included ? /* @__PURE__ */ jsx17("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "3", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx17("path", { d: "M20 6L9 17l-5-5" }) }) : null
    }
  );
}
function DiffTable({
  rows = ROWS2,
  addedRow = ADDED,
  title = "Proposed local instruction",
  columns = ["Rule", "Scope", "Instruction"],
  onApply,
  onSelectionChange
} = {}) {
  const reduce = useReducedMotion();
  const stage = useStage(STAGE_DELAYS, reduce);
  const busy = useRef10(false);
  const [pending, setPending] = useState14(false);
  const [error, setError] = useState14("");
  const tinted = stage >= 1;
  const settled = stage >= 2;
  const [accepted, setAccepted] = useState14(false);
  const [edits, setEdits] = useState14(() => Object.fromEntries([...rows.filter((r) => r.removed), addedRow].map((r) => [r.key, true])));
  const removals = rows.filter((row) => row.removed && edits[row.key]).length;
  const additions = edits[addedRow.key] ? 1 : 0;
  const showAdded = settled;
  const selection = (values) => ({ removed: rows.filter((r) => r.removed && values[r.key]), added: values[addedRow.key] ? [addedRow] : [] });
  const toggleEdit = (key) => {
    if (busy.current) return;
    const next = { ...edits, [key]: !edits[key] };
    setEdits(next);
    onSelectionChange?.(selection(next));
  };
  return /* @__PURE__ */ jsxs14("div", { "data-reduced-motion": reduce, className: "hermes-ui w-full max-w-95", children: [
    error && /* @__PURE__ */ jsx17("p", { role: "alert", className: "mb-2 text-[12px] text-red", children: error }),
    /* @__PURE__ */ jsxs14("div", { className: "relative overflow-hidden rounded-card bg-surface shadow-card", children: [
      /* @__PURE__ */ jsxs14("div", { className: "primitive-card-bar flex items-center justify-between border-b border-line", children: [
        /* @__PURE__ */ jsx17("span", { className: "text-[12.5px] font-medium text-ink", children: title }),
        settled && !accepted && /* @__PURE__ */ jsx17("span", { className: "text-[11px] text-ink-3", children: "Click changed rows to toggle" })
      ] }),
      /* @__PURE__ */ jsxs14("table", { className: "w-full table-fixed border-collapse text-left", children: [
        /* @__PURE__ */ jsxs14("colgroup", { children: [
          /* @__PURE__ */ jsx17("col", { className: "w-[34%]" }),
          /* @__PURE__ */ jsx17("col", { className: "w-[30%]" }),
          /* @__PURE__ */ jsx17("col", { className: "w-[36%]" })
        ] }),
        /* @__PURE__ */ jsx17("thead", { children: /* @__PURE__ */ jsx17("tr", { className: "border-b border-line", children: columns.map((h) => /* @__PURE__ */ jsx17("th", { className: "primitive-table-cell text-[12px] font-medium text-ink-3", children: h }, h)) }) }),
        /* @__PURE__ */ jsxs14("tbody", { children: [
          rows.map((row) => {
            const out = row.removed && tinted && edits[row.key];
            const interactive = row.removed && settled && !accepted;
            return /* @__PURE__ */ jsxs14(
              "tr",
              {
                tabIndex: interactive ? 0 : void 0,
                "aria-selected": row.removed ? edits[row.key] : void 0,
                onClick: interactive ? () => toggleEdit(row.key) : void 0,
                onKeyDown: interactive ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggleEdit(row.key);
                  }
                } : void 0,
                className: `border-b border-line transition-[background-color,filter,opacity] duration-150 last:border-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${interactive ? "cursor-pointer hover:brightness-[0.985]" : ""}`,
                style: { background: out ? "var(--red-tint)" : void 0 },
                children: [
                  /* @__PURE__ */ jsx17(
                    "td",
                    {
                      className: "primitive-table-cell text-[13px] font-medium tabular-nums transition-colors duration-200",
                      style: { color: out ? "var(--red)" : "var(--ink)" },
                      children: row.id
                    }
                  ),
                  /* @__PURE__ */ jsx17("td", { className: "primitive-table-cell", children: /* @__PURE__ */ jsxs14(
                    "span",
                    {
                      className: "inline-flex h-5.5 items-center gap-1.5 rounded-full bg-inset px-2 text-[11.5px] font-medium shadow-hairline transition-opacity duration-200",
                      style: { opacity: out ? 0.55 : 1 },
                      children: [
                        /* @__PURE__ */ jsx17("span", { className: `size-1.5 rounded-full ${DOT[row.dept]}` }),
                        /* @__PURE__ */ jsx17("span", { className: "text-ink-2", children: row.dept })
                      ]
                    }
                  ) }),
                  /* @__PURE__ */ jsx17(
                    "td",
                    {
                      className: "primitive-table-cell text-[12.5px] whitespace-nowrap transition-colors duration-200",
                      style: {
                        color: out ? "var(--red)" : "var(--ink-2)",
                        textDecorationLine: out ? "line-through" : "none",
                        textDecorationColor: "color-mix(in srgb, var(--red) 50%, transparent)"
                      },
                      children: /* @__PURE__ */ jsxs14("span", { className: "flex items-center justify-between gap-2", children: [
                        /* @__PURE__ */ jsx17("span", { className: "min-w-0 truncate", children: row.email }),
                        row.removed && settled && /* @__PURE__ */ jsx17(IncludedMark, { included: edits[row.key], tone: "red" })
                      ] })
                    }
                  )
                ]
              },
              row.key
            );
          }),
          /* @__PURE__ */ jsx17("tr", { children: /* @__PURE__ */ jsx17("td", { colSpan: 3, className: "p-0", children: /* @__PURE__ */ jsx17(
            "div",
            {
              className: "grid transition-[grid-template-rows,opacity] duration-200",
              style: {
                gridTemplateRows: showAdded ? "1fr" : "0fr",
                opacity: showAdded ? 1 : 0,
                transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)"
              },
              children: /* @__PURE__ */ jsx17("div", { className: "overflow-hidden", children: /* @__PURE__ */ jsxs14(
                "div",
                {
                  role: "checkbox",
                  tabIndex: accepted || !showAdded ? -1 : 0,
                  "aria-checked": edits[addedRow.key],
                  "aria-label": `Include adding ${addedRow.id}`,
                  onClick: accepted ? void 0 : () => toggleEdit(addedRow.key),
                  onKeyDown: accepted ? void 0 : (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleEdit(addedRow.key);
                    }
                  },
                  className: `grid grid-cols-[34%_30%_36%] items-center border-t border-line transition-[background-color,filter,opacity] duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${accepted ? "" : "cursor-pointer hover:brightness-[0.985]"}`,
                  style: { background: edits[addedRow.key] ? "var(--green-tint)" : void 0 },
                  children: [
                    /* @__PURE__ */ jsx17("span", { className: "primitive-table-cell text-[13px] font-medium tabular-nums transition-colors duration-200", style: { color: edits[addedRow.key] ? "var(--green)" : "var(--ink-3)" }, children: addedRow.id }),
                    /* @__PURE__ */ jsx17("span", { className: "primitive-table-cell", children: /* @__PURE__ */ jsxs14("span", { className: "inline-flex h-5.5 items-center gap-1.5 rounded-full bg-surface px-2 text-[11.5px] font-medium shadow-hairline", children: [
                      /* @__PURE__ */ jsx17("span", { className: "size-1.5 rounded-full bg-green" }),
                      /* @__PURE__ */ jsx17("span", { className: "text-ink-2", children: addedRow.dept })
                    ] }) }),
                    /* @__PURE__ */ jsx17("span", { className: "primitive-table-cell text-[13px] transition-colors duration-200", style: { color: edits[addedRow.key] ? "var(--green)" : "var(--ink-3)" }, children: /* @__PURE__ */ jsxs14("span", { className: "flex items-center justify-between gap-2", children: [
                      /* @__PURE__ */ jsx17("span", { className: "min-w-0 truncate", children: addedRow.email }),
                      /* @__PURE__ */ jsx17(IncludedMark, { included: edits[addedRow.key], tone: "green" })
                    ] }) })
                  ]
                }
              ) })
            }
          ) }) })
        ] })
      ] }),
      settled && /* @__PURE__ */ jsx17(
        "div",
        {
          className: "primitive-card-footer flex min-h-11 items-center justify-between border-t border-line",
          style: { animation: "fade-up 180ms cubic-bezier(0.23,1,0.32,1) both" },
          children: accepted ? /* @__PURE__ */ jsxs14(
            "span",
            {
              className: "inline-flex items-center gap-1.5 rounded-full bg-green-tint py-1 pr-2.5 pl-1 text-[12.5px] font-medium text-green",
              style: { animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both" },
              children: [
                /* @__PURE__ */ jsx17("span", { className: "flex size-4.5 items-center justify-center rounded-full bg-green text-white", children: /* @__PURE__ */ jsx17("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "3", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx17("path", { d: "M20 6L9 17l-5-5" }) }) }),
                removals + additions,
                " ",
                removals + additions === 1 ? "edit" : "edits",
                " saved for Iris"
              ]
            }
          ) : /* @__PURE__ */ jsxs14(Fragment5, { children: [
            /* @__PURE__ */ jsxs14("span", { className: "text-[11.5px] tabular-nums text-ink-3", children: [
              removals,
              " ",
              removals === 1 ? "removal" : "removals",
              " \xB7 ",
              additions,
              " ",
              additions === 1 ? "addition" : "additions"
            ] }),
            /* @__PURE__ */ jsx17("span", { className: "flex items-center gap-1.5", children: /* @__PURE__ */ jsxs14(
              Button,
              {
                variant: "accent",
                size: "sm",
                disabled: removals + additions === 0 || pending || !onApply,
                onClick: async () => {
                  if (busy.current || !onApply) return;
                  busy.current = true;
                  setPending(true);
                  setError("");
                  try {
                    await onApply(selection(edits));
                    setAccepted(true);
                  } catch {
                    setError("Changes were not saved. Try again.");
                  } finally {
                    busy.current = false;
                    setPending(false);
                  }
                },
                className: "text-[12px]",
                children: [
                  pending ? "Saving" : "Save",
                  " ",
                  removals + additions,
                  " ",
                  removals + additions === 1 ? "change" : "changes"
                ]
              }
            ) })
          ] })
        }
      )
    ] })
  ] });
}

// src/components/primitives/RecordsTable.tsx
import { useEffect as useEffect13, useLayoutEffect as useLayoutEffect4, useMemo, useRef as useRef11, useState as useState15 } from "react";
import { createPortal as createPortal3 } from "react-dom";
import { Fragment as Fragment6, jsx as jsx18, jsxs as jsxs15 } from "react/jsx-runtime";
var DEFAULT_COLUMN_WIDTHS = {
  company: 270,
  categories: 275,
  last: 190,
  strength: 210,
  links: 175,
  ai: 240
};
var STRENGTH = {
  strong: { label: "Sources checked", color: "var(--green)", rank: 3 },
  weak: { label: "Gaps open", color: "var(--orange)", rank: 2 },
  veryweak: { label: "Sources missing", color: "var(--red)", rank: 1 },
  none: { label: "Not assessed", color: "var(--ink-3)", rank: 0 }
};
var TAG_PALETTE = {
  amber: { base: "oklch(0.76 0.13 70)" },
  lime: { base: "oklch(0.77 0.16 122)" },
  yellow: { base: "oklch(0.80 0.15 101)" },
  purple: { base: "oklch(0.62 0.18 293)" },
  orange: { base: "oklch(0.71 0.16 48)" },
  cyan: { base: "oklch(0.72 0.10 221)" },
  red: { base: "oklch(0.64 0.19 27)" },
  magenta: { base: "oklch(0.66 0.21 323)" },
  green: { base: "oklch(0.70 0.13 162)" },
  pink: { base: "oklch(0.67 0.19 3)" }
};
var TAG_COLORS = {
  Applicant: TAG_PALETTE.cyan,
  Technical: TAG_PALETTE.purple,
  Provider: TAG_PALETTE.amber,
  Onboarding: TAG_PALETTE.green,
  "Needs review": TAG_PALETTE.orange,
  "Needs context": TAG_PALETTE.yellow
};
var PARTNER_RECORDS = [
  { id: "leah", name: "Leah", tags: ["Applicant", "Technical", "Needs review"], last: "2026-10-12", strength: "weak", reviewGap: "Customer impact unverified; timeline missing" },
  { id: "owen", name: "Owen Brooks", tags: ["Applicant", "Technical", "Needs review"], last: "2026-10-12", strength: "weak", reviewGap: "Customer impact unverified; capacity unconfirmed" },
  { id: "robin", name: "Robin Ellis", tags: ["Provider", "Needs review"], last: "2026-10-09", strength: "strong", reviewGap: "Delivery and consent cited; documents await Maya" },
  { id: "noor", name: "Noor", tags: ["Onboarding", "Needs context"], last: "2026-10-12", strength: "veryweak", reviewGap: "Feedback destination missing" }
];
var AI_LABEL = "Review gaps";
function Icon2({ children, size = 14, strokeWidth = 1.8 }) {
  return /* @__PURE__ */ jsx18("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children });
}
var TYPE_GLYPHS = {
  Text: /* @__PURE__ */ jsx18("path", { d: "M4 6h16M4 12h10M4 18h7" }),
  File: /* @__PURE__ */ jsxs15("g", { children: [
    /* @__PURE__ */ jsx18("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }),
    /* @__PURE__ */ jsx18("path", { d: "M14 2v6h6" })
  ] }),
  Collection: /* @__PURE__ */ jsxs15("g", { children: [
    /* @__PURE__ */ jsx18("ellipse", { cx: "12", cy: "5", rx: "8", ry: "3" }),
    /* @__PURE__ */ jsx18("path", { d: "M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" })
  ] }),
  "Single select": /* @__PURE__ */ jsxs15("g", { children: [
    /* @__PURE__ */ jsx18("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ jsx18("path", { d: "m8.5 12 2.4 2.4 4.6-4.9" })
  ] }),
  "Multi select": /* @__PURE__ */ jsxs15("g", { children: [
    /* @__PURE__ */ jsx18("path", { d: "M11 6h9M11 12h9M11 18h9" }),
    /* @__PURE__ */ jsx18("path", { d: "M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17" })
  ] }),
  URL: /* @__PURE__ */ jsxs15("g", { children: [
    /* @__PURE__ */ jsx18("path", { d: "M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" }),
    /* @__PURE__ */ jsx18("path", { d: "M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" })
  ] }),
  Reference: /* @__PURE__ */ jsx18("path", { d: "M7 17 17 7M9 7h8v8" }),
  JSON: /* @__PURE__ */ jsxs15("g", { children: [
    /* @__PURE__ */ jsx18("path", { d: "M8 4c-2 0-2 2-2 3s.5 3-2 3c2.5 0 2 2 2 3s0 3 2 3" }),
    /* @__PURE__ */ jsx18("path", { d: "M16 4c2 0 2 2 2 3s-.5 3 2 3c-2.5 0-2 2-2 3s0 3-2 3" })
  ] }),
  "File splitter": /* @__PURE__ */ jsxs15("g", { children: [
    /* @__PURE__ */ jsx18("rect", { x: "8", y: "8", width: "12", height: "12", rx: "2" }),
    /* @__PURE__ */ jsx18("path", { d: "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" })
  ] }),
  Date: /* @__PURE__ */ jsxs15("g", { children: [
    /* @__PURE__ */ jsx18("rect", { x: "3", y: "5", width: "18", height: "16", rx: "2.5" }),
    /* @__PURE__ */ jsx18("path", { d: "M8 3v4M16 3v4M3 10h18" })
  ] })
};
var TOOL_GLYPHS = {
  model: /* @__PURE__ */ jsx18("path", { d: "M12 3l1.7 5.1a2 2 0 0 0 1.2 1.2L20 11l-5.1 1.7a2 2 0 0 0-1.2 1.2L12 19l-1.7-5.1a2 2 0 0 0-1.2-1.2L4 11l5.1-1.7a2 2 0 0 0 1.2-1.2z" }),
  web: /* @__PURE__ */ jsxs15("g", { children: [
    /* @__PURE__ */ jsx18("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ jsx18("path", { d: "M3 12h18M12 3a13.5 13.5 0 0 1 3.5 9 13.5 13.5 0 0 1-3.5 9 13.5 13.5 0 0 1-3.5-9A13.5 13.5 0 0 1 12 3z" })
  ] }),
  user: /* @__PURE__ */ jsxs15("g", { children: [
    /* @__PURE__ */ jsx18("circle", { cx: "12", cy: "8", r: "4" }),
    /* @__PURE__ */ jsx18("path", { d: "M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" })
  ] })
};
var COLUMN_META = {
  Record: { type: "Text", tool: "User input", toolKind: "user" },
  Type: { type: "Multi select", tool: "DeepSeek 4.1 Flash", toolKind: "model", inputs: "Record", prompt: { before: "Tag each ", chip: "Record", after: " with its program role." } },
  "Last updated": { type: "Date", tool: "User input", toolKind: "user" },
  "Evidence coverage": { type: "Single select", tool: "DeepSeek 4.1 Flash", toolKind: "model", inputs: "Record", prompt: { before: "Inspect cited evidence from ", chip: "Record", after: "." } },
  Links: { type: "URL", tool: "Web search", toolKind: "web", inputs: "Record", prompt: { before: "Find the website for ", chip: "Record", after: "." } },
  [AI_LABEL]: { type: "Text", tool: "DeepSeek 4.1 Flash", toolKind: "model", inputs: "Record", prompt: { before: "Find cited gaps for ", chip: "Record" } }
};
var NEW_PROPERTY_TYPES = ["Text", "File", "Collection", "Single select", "Multi select", "URL", "Reference", "JSON", "File splitter"];
var MODEL_OPTIONS = ["DeepSeek 4.1 Flash", "Opus 4.7", "GPT-5.5"];
var INPUT_OPTIONS = ["Record", "Type", "Last updated", "Evidence coverage", "Links"];
function Checkbox({ checked, mixed = false, onChange, label }) {
  return /* @__PURE__ */ jsxs15("label", { className: "records-checkbox", title: label, onClick: (event) => event.stopPropagation(), children: [
    /* @__PURE__ */ jsx18("input", { type: "checkbox", checked, onChange, "aria-label": label }),
    /* @__PURE__ */ jsx18("span", { className: `records-checkbox-box ${checked || mixed ? "is-active" : ""}`, children: mixed ? /* @__PURE__ */ jsx18("span", { className: "records-checkbox-dash" }) : checked ? /* @__PURE__ */ jsx18(Icon2, { size: 12, children: /* @__PURE__ */ jsx18("path", { d: "m5 12 4 4L19 6" }) }) : null })
  ] });
}
function Tag({ name }) {
  const color = TAG_COLORS[name] ?? { base: "var(--ink-3)" };
  return /* @__PURE__ */ jsx18(
    "span",
    {
      className: "records-tag",
      style: { "--tag-base": color.base },
      children: name
    }
  );
}
function TagList({ tags }) {
  const containerRef = useRef11(null);
  const measureRef = useRef11(null);
  const [visibleCount, setVisibleCount] = useState15(tags.length);
  useLayoutEffect4(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;
    const update = () => {
      const available = container.clientWidth;
      const tagWidths = Array.from(measure.querySelectorAll("[data-tag-measure]"), (tag) => tag.offsetWidth);
      const moreWidth = measure.querySelector("[data-more-measure]")?.offsetWidth ?? 0;
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
  return /* @__PURE__ */ jsxs15("div", { ref: containerRef, className: "records-tags", title: tags.join(", "), "aria-label": `Type: ${tags.join(", ")}`, children: [
    /* @__PURE__ */ jsxs15("div", { ref: measureRef, className: "records-tags-measure", "aria-hidden": true, children: [
      tags.map((tag) => /* @__PURE__ */ jsx18("span", { "data-tag-measure": true, children: /* @__PURE__ */ jsx18(Tag, { name: tag }) }, tag)),
      /* @__PURE__ */ jsxs15("span", { "data-more-measure": true, className: "records-more-tag", children: [
        "+",
        tags.length
      ] })
    ] }),
    tags.slice(0, visibleCount).map((tag) => /* @__PURE__ */ jsx18(Tag, { name: tag }, tag)),
    hiddenCount > 0 && /* @__PURE__ */ jsxs15("span", { className: "records-more-tag", children: [
      "+",
      hiddenCount
    ] })
  ] });
}
function CalcCell() {
  return /* @__PURE__ */ jsxs15("span", { className: "records-calc", children: [
    /* @__PURE__ */ jsx18("span", { className: "records-muted", children: "Calculating\u2026" }),
    /* @__PURE__ */ jsx18("span", { className: "records-pulse" })
  ] });
}
function MiniSwitch({ on, onToggle, label }) {
  return /* @__PURE__ */ jsx18(
    "button",
    {
      type: "button",
      role: "switch",
      "aria-checked": on,
      "aria-label": label,
      onClick: onToggle,
      className: "relative h-4.5 w-7.5 shrink-0 rounded-full transition-colors duration-150",
      style: { background: on ? "var(--accent)" : "var(--line-strong)" },
      children: /* @__PURE__ */ jsx18(
        "span",
        {
          className: "absolute top-0.5 left-0.5 size-3.5 rounded-full bg-white shadow-btn transition-transform duration-150",
          style: { transform: on ? "translateX(12px)" : "translateX(0)", transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)" }
        }
      )
    }
  );
}
function HeaderCell({ label, icon, sortKey, sort, onSort, onResizeStart, resizing = false, className = "", selected = false, onPick }) {
  return /* @__PURE__ */ jsxs15("th", { className: `records-header-cell ${selected ? "is-colsel" : ""} ${className}`, children: [
    /* @__PURE__ */ jsxs15("div", { className: "records-header-button", children: [
      /* @__PURE__ */ jsxs15(
        "button",
        {
          type: "button",
          className: "flex h-full min-w-0 flex-1 items-center gap-2 text-left",
          onClick: onPick,
          children: [
            /* @__PURE__ */ jsx18("span", { className: "records-header-icon", children: icon }),
            /* @__PURE__ */ jsx18("span", { className: "truncate", children: label })
          ]
        }
      ),
      sortKey && /* @__PURE__ */ jsx18(
        "button",
        {
          type: "button",
          "aria-label": `Sort by ${label}`,
          onClick: (event) => {
            event.stopPropagation();
            onSort(sortKey);
          },
          className: `records-sort focus-visible:opacity-100 ${sort.key === sortKey ? "is-visible" : ""}`,
          style: { transform: sort.key === sortKey && sort.dir === -1 ? "rotate(180deg)" : void 0 },
          children: /* @__PURE__ */ jsx18(Icon2, { size: 12, children: /* @__PURE__ */ jsx18("path", { d: "M12 5v14M5 12l7 7 7-7" }) })
        }
      )
    ] }),
    /* @__PURE__ */ jsx18(
      "span",
      {
        role: "separator",
        "aria-orientation": "vertical",
        "aria-label": `Resize ${label} column`,
        className: `records-resize-handle ${resizing ? "is-resizing" : ""}`,
        onPointerDown: onResizeStart
      }
    )
  ] });
}
function ConfigRow({ label, children }) {
  return /* @__PURE__ */ jsxs15("div", { className: "relative flex h-8 items-center justify-between", children: [
    /* @__PURE__ */ jsx18("span", { className: "text-[13px] text-ink-3", children: label }),
    children
  ] });
}
function menuBounds(x, y, preferredWidth, preferredHeight) {
  const width = Math.min(preferredWidth, window.innerWidth - 24);
  const top = Math.max(12, Math.min(y, window.innerHeight - preferredHeight - 12));
  return {
    left: Math.max(12, Math.min(x, window.innerWidth - width - 12)),
    top,
    width,
    maxHeight: Math.max(80, window.innerHeight - top - 12),
    overflowY: "auto",
    overscrollBehavior: "contain"
  };
}
function MenuSurface({ label, width, height, children }) {
  const anchor = useRef11(null);
  const reduce = useReducedMotion();
  const [placement, setPlacement] = useState15(null);
  useLayoutEffect4(() => {
    const measure = () => {
      const rect = anchor.current?.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const x = rect.right + width + 18 <= window.innerWidth ? rect.right + 6 : rect.left - width - 6 >= 12 ? rect.left - width - 6 : window.innerWidth - width - 12;
      setPlacement(menuBounds(x, rect.top, width, height));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [width, height]);
  return /* @__PURE__ */ jsxs15(Fragment6, { children: [
    /* @__PURE__ */ jsx18("span", { ref: anchor, "aria-hidden": true, className: "pointer-events-none absolute size-0" }),
    placement && createPortal3(
      /* @__PURE__ */ jsx18(
        "div",
        {
          "data-recpop": true,
          "data-reduced-motion": reduce,
          role: "menu",
          "aria-label": label,
          className: "hermes-ui fixed z-[70] rounded-[12px] bg-surface p-1.5 shadow-overlay",
          style: { ...placement, animation: reduce ? "none" : "pop-in 140ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" },
          children
        }
      ),
      document.body
    )
  ] });
}
function ConfigPicker({
  label,
  options,
  selected,
  onSelect
}) {
  return /* @__PURE__ */ jsxs15(MenuSurface, { label, width: 210, height: options.length * 33 + 36, children: [
    /* @__PURE__ */ jsx18("div", { className: "px-2 pb-1 pt-0.5 text-[11.5px] font-medium text-ink-3", children: label }),
    /* @__PURE__ */ jsx18(GlideMenu, { className: "flex flex-col gap-px", children: options.map((option) => /* @__PURE__ */ jsxs15(
      "button",
      {
        "data-menu-row": true,
        type: "button",
        role: "menuitemradio",
        "aria-checked": selected === option.label,
        onClick: () => onSelect(option.label),
        className: "relative z-10 flex h-8 w-full items-center gap-1.5 rounded-[8px] px-1.5 text-left text-[13px] font-medium text-ink",
        children: [
          /* @__PURE__ */ jsx18("span", { className: "flex size-4 shrink-0 items-center justify-center text-ink-2", children: option.icon }),
          /* @__PURE__ */ jsx18("span", { className: "min-w-0 flex-1 truncate", children: option.label }),
          /* @__PURE__ */ jsx18("span", { className: selected === option.label ? "text-ink" : "invisible", children: /* @__PURE__ */ jsx18(Icon2, { size: 14, strokeWidth: 2.2, children: /* @__PURE__ */ jsx18("path", { d: "m5 12 4 4L19 6" }) }) })
        ]
      },
      option.label
    )) })
  ] });
}
function InputPicker({
  options,
  selected,
  onToggle
}) {
  return /* @__PURE__ */ jsxs15(MenuSurface, { label: "Calculation inputs", width: 220, height: options.length * 33 + 36, children: [
    /* @__PURE__ */ jsx18("div", { className: "px-2 pb-1 pt-0.5 text-[11.5px] font-medium text-ink-3", children: "Use values from" }),
    /* @__PURE__ */ jsx18(GlideMenu, { className: "flex flex-col gap-px", children: options.map((option) => {
      const checked = selected.includes(option);
      return /* @__PURE__ */ jsxs15(
        "button",
        {
          "data-menu-row": true,
          type: "button",
          role: "menuitemcheckbox",
          "aria-checked": checked,
          onClick: () => onToggle(option),
          className: "relative z-10 flex h-8 w-full items-center gap-1.5 rounded-[8px] px-1.5 text-left text-[13px] font-medium text-ink",
          children: [
            /* @__PURE__ */ jsx18("span", { className: `flex size-4 shrink-0 items-center justify-center rounded-[5px] border ${checked ? "border-accent bg-accent text-white" : "border-line-strong text-transparent"}`, children: /* @__PURE__ */ jsx18(Icon2, { size: 11, strokeWidth: 2.4, children: /* @__PURE__ */ jsx18("path", { d: "m5 12 4 4L19 6" }) }) }),
            /* @__PURE__ */ jsx18("span", { className: "min-w-0 flex-1 truncate", children: option })
          ]
        },
        option
      );
    }) })
  ] });
}
function RecordsTable({ rows = PARTNER_RECORDS, fill = false, onSelectionChange, onOpenRow, onCalculate } = {}) {
  const reduce = useReducedMotion();
  const requestId = useRef11(0);
  const [calculating, setCalculating] = useState15(false);
  const [calculationError, setCalculationError] = useState15("");
  const [values, setValues] = useState15({});
  const promptRef = useRef11(null);
  const resizeCleanup = useRef11(null);
  useEffect13(() => () => {
    requestId.current++;
    resizeCleanup.current?.();
  }, []);
  const [selected, setSelected] = useState15(/* @__PURE__ */ new Set());
  const [sort, setSort] = useState15({ key: "name", dir: 1 });
  const [columnWidths, setColumnWidths] = useState15(DEFAULT_COLUMN_WIDTHS);
  const [actionColumnWidth, setActionColumnWidth] = useState15(100);
  const [columnWidthsLocked, setColumnWidthsLocked] = useState15(false);
  const [resizingColumn, setResizingColumn] = useState15(null);
  const initialColumnWidthsRef = useRef11(null);
  const tableRef = useRef11(null);
  const [prop, setProp] = useState15(null);
  const [grounding, setGrounding] = useState15(true);
  const [groundingHelpOpen, setGroundingHelpOpen] = useState15(false);
  const [configMenu, setConfigMenu] = useState15(null);
  const [columnOverrides, setColumnOverrides] = useState15({});
  const [inputSelections, setInputSelections] = useState15({});
  const [pinnedColumns, setPinnedColumns] = useState15(() => new Set(typeof window !== "undefined" && window.innerWidth < 640 ? [] : ["Record"]));
  useEffect13(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const adapt = () => {
      if (media.matches) setPinnedColumns(/* @__PURE__ */ new Set());
    };
    adapt();
    media.addEventListener("change", adapt);
    return () => media.removeEventListener("change", adapt);
  }, []);
  const [moreSettingsOpen, setMoreSettingsOpen] = useState15(false);
  const [advancedSettings, setAdvancedSettings] = useState15({ required: false, allowEmpty: true, confidence: false });
  const [addOpen, setAddOpen] = useState15(null);
  const [tableMenuOpen, setTableMenuOpen] = useState15(null);
  const [aiAdded, setAiAdded] = useState15(false);
  const [aiDone, setAiDone] = useState15(false);
  const [pendingOpenAi, setPendingOpenAi] = useState15(false);
  const aiThRef = useRef11(null);
  const ignoreScrollRef = useRef11(false);
  const [calc, setCalc] = useState15(null);
  useLayoutEffect4(() => {
    if (columnWidthsLocked || !tableRef.current) return;
    const headers = Array.from(tableRef.current.querySelectorAll("thead th"));
    if (headers.length < 6) return;
    const measured = {
      company: headers[0].getBoundingClientRect().width,
      categories: headers[1].getBoundingClientRect().width,
      last: headers[2].getBoundingClientRect().width,
      strength: headers[3].getBoundingClientRect().width,
      links: headers[4].getBoundingClientRect().width,
      ai: DEFAULT_COLUMN_WIDTHS.ai
    };
    initialColumnWidthsRef.current = measured;
    setColumnWidths(measured);
    setActionColumnWidth(headers[headers.length - 1].getBoundingClientRect().width);
    setColumnWidthsLocked(true);
  }, [columnWidthsLocked]);
  useLayoutEffect4(() => {
    if (!tableRef.current) return;
    const columns = [
      { label: "Record", width: columnWidths.company },
      { label: "Type", width: columnWidths.categories },
      { label: "Last updated", width: columnWidths.last },
      { label: "Evidence coverage", width: columnWidths.strength },
      { label: "Links", width: columnWidths.links },
      ...aiAdded ? [{ label: AI_LABEL, width: columnWidths.ai }] : []
    ];
    let left = 0;
    columns.forEach((column, index) => {
      const pinned = pinnedColumns.has(column.label);
      tableRef.current.querySelectorAll(`tr > :nth-child(${index + 1})`).forEach((cell) => {
        cell.style.position = pinned || cell.tagName === "TH" ? "sticky" : "static";
        cell.style.left = pinned ? `${left}px` : "auto";
        cell.style.zIndex = pinned ? cell.tagName === "TH" ? "14" : "3" : "";
        cell.style.backgroundColor = pinned ? cell.parentElement?.classList.contains("is-selected") ? "var(--hover)" : "var(--surface)" : "";
      });
      if (pinned) left += column.width;
    });
  }, [pinnedColumns, aiAdded, columnWidths, selected]);
  const visibleRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const value = sort.key === "name" ? a.name.localeCompare(b.name) : sort.key === "last" ? a.last.localeCompare(b.last) : STRENGTH[a.strength].rank - STRENGTH[b.strength].rank;
      return value * sort.dir;
    });
  }, [rows, sort]);
  useEffect13(() => {
    if (!calc) return;
    if (reduce) {
      if (calc.col === AI_LABEL) setAiDone(true);
      setCalc(null);
      return;
    }
    if (calc.resolved > visibleRows.length) {
      if (calc.col === AI_LABEL) setAiDone(true);
      setCalc(null);
      return;
    }
    const t = setTimeout(() => setCalc((current) => current ? { ...current, resolved: current.resolved + 1 } : current), 110);
    return () => clearTimeout(t);
  }, [calc, visibleRows.length, reduce]);
  useEffect13(() => {
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
  useEffect13(() => {
    if (!prop && !addOpen && !tableMenuOpen) return;
    const escape = (event) => {
      if (event.key === "Escape") {
        setProp(null);
        setAddOpen(null);
        setTableMenuOpen(null);
        setConfigMenu(null);
      }
    };
    document.addEventListener("keydown", escape);
    const close = (event) => {
      if (!event.target.closest("[data-recpop]")) {
        setProp(null);
        setConfigMenu(null);
        setGroundingHelpOpen(false);
        setMoreSettingsOpen(false);
        setAddOpen(null);
        setTableMenuOpen(null);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [prop, addOpen, tableMenuOpen]);
  const openProp = (col) => (event) => {
    const th = event.currentTarget.closest("th");
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
  const isCalc = (col, index) => !!calc && calc.col === col && index >= calc.resolved;
  const allSelected = visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.id));
  const partiallySelected = !allSelected && visibleRows.some((row) => selected.has(row.id));
  const toggleSort = (key) => setSort((current) => current.key === key ? { key, dir: current.dir * -1 } : { key, dir: 1 });
  const startColumnResize = (key, minWidth = 120) => (event) => {
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
    const move = (moveEvent) => {
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
  const toggleRow = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
    onSelectionChange?.([...next]);
  };
  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) visibleRows.forEach((row) => next.delete(row.id));
    else visibleRows.forEach((row) => next.add(row.id));
    setSelected(next);
    onSelectionChange?.([...next]);
  };
  const meta = prop ? { ...COLUMN_META[prop.col], ...columnOverrides[prop.col] } : null;
  const selectedInputs = prop && meta ? inputSelections[prop.col] ?? (meta.inputs ? [meta.inputs] : []) : [];
  const tableWidth = columnWidths.company + columnWidths.categories + columnWidths.last + columnWidths.strength + columnWidths.links + (aiAdded ? columnWidths.ai : 0) + actionColumnWidth;
  return /* @__PURE__ */ jsxs15("div", { "data-reduced-motion": reduce, className: `hermes-ui records-shell${fill ? " is-fill" : ""}`, children: [
    /* @__PURE__ */ jsx18(
      "div",
      {
        className: "records-scroll",
        tabIndex: 0,
        "aria-label": "Program records table. Scroll horizontally and vertically to view all columns and records.",
        onScroll: () => {
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
        },
        children: /* @__PURE__ */ jsxs15("table", { ref: tableRef, className: "records-table", style: { width: columnWidthsLocked ? tableWidth : "100%", minWidth: tableWidth }, children: [
          /* @__PURE__ */ jsxs15("colgroup", { children: [
            /* @__PURE__ */ jsx18("col", { className: "records-company-col", style: { width: columnWidths.company } }),
            /* @__PURE__ */ jsx18("col", { className: "records-category-col", style: { width: columnWidths.categories } }),
            /* @__PURE__ */ jsx18("col", { className: "records-last-col", style: { width: columnWidths.last } }),
            /* @__PURE__ */ jsx18("col", { className: "records-strength-col", style: { width: columnWidths.strength } }),
            /* @__PURE__ */ jsx18("col", { className: "records-link-col", style: { width: columnWidths.links } }),
            aiAdded && /* @__PURE__ */ jsx18("col", { style: { width: columnWidths.ai } }),
            /* @__PURE__ */ jsx18("col", { style: { width: 100 } })
          ] }),
          /* @__PURE__ */ jsx18("thead", { children: /* @__PURE__ */ jsxs15("tr", { children: [
            /* @__PURE__ */ jsxs15("th", { className: `records-header-cell records-sticky-cell ${prop?.col === "Record" ? "is-colsel" : ""}`, children: [
              /* @__PURE__ */ jsxs15("div", { className: "records-company-header", style: { cursor: "pointer" }, onClick: (event) => openProp("Record")(event), children: [
                /* @__PURE__ */ jsx18(Checkbox, { checked: allSelected, mixed: partiallySelected, onChange: toggleAll, label: "Select all records" }),
                /* @__PURE__ */ jsx18("span", { children: "Record" }),
                /* @__PURE__ */ jsx18("button", { type: "button", "aria-label": "Sort records by name", onClick: (event) => {
                  event.stopPropagation();
                  toggleSort("name");
                }, className: "ml-auto text-ink-3", children: /* @__PURE__ */ jsx18(Icon2, { size: 12, children: /* @__PURE__ */ jsx18("path", { d: "M12 5v14M5 12l7 7 7-7" }) }) })
              ] }),
              /* @__PURE__ */ jsx18("span", { role: "separator", "aria-orientation": "vertical", "aria-label": "Resize Record column", className: `records-resize-handle ${resizingColumn === "company" ? "is-resizing" : ""}`, onPointerDown: startColumnResize("company", 180) })
            ] }),
            /* @__PURE__ */ jsx18(HeaderCell, { label: "Type", selected: prop?.col === "Type", onPick: openProp("Type"), sort, onSort: toggleSort, onResizeStart: startColumnResize("categories"), resizing: resizingColumn === "categories", icon: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: TYPE_GLYPHS["Multi select"] }) }),
            /* @__PURE__ */ jsx18(HeaderCell, { label: "Last updated", selected: prop?.col === "Last updated", onPick: openProp("Last updated"), sortKey: "last", sort, onSort: toggleSort, onResizeStart: startColumnResize("last"), resizing: resizingColumn === "last", icon: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: TYPE_GLYPHS.Date }) }),
            /* @__PURE__ */ jsx18(HeaderCell, { label: "Evidence coverage", selected: prop?.col === "Evidence coverage", onPick: openProp("Evidence coverage"), sortKey: "strength", sort, onSort: toggleSort, onResizeStart: startColumnResize("strength"), resizing: resizingColumn === "strength", icon: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: TYPE_GLYPHS["Single select"] }) }),
            /* @__PURE__ */ jsx18(HeaderCell, { label: "Links", selected: prop?.col === "Links", onPick: openProp("Links"), sort, onSort: toggleSort, onResizeStart: startColumnResize("links"), resizing: resizingColumn === "links", icon: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: TYPE_GLYPHS.URL }) }),
            aiAdded && /* @__PURE__ */ jsxs15("th", { ref: aiThRef, className: `records-header-cell ${prop?.col === AI_LABEL ? "is-colsel" : ""}`, children: [
              /* @__PURE__ */ jsxs15("button", { type: "button", className: "records-header-button", onClick: openProp(AI_LABEL), children: [
                /* @__PURE__ */ jsx18("span", { className: "records-header-icon", children: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: TYPE_GLYPHS.Text }) }),
                /* @__PURE__ */ jsx18("span", { className: "truncate", children: AI_LABEL })
              ] }),
              /* @__PURE__ */ jsx18("span", { role: "separator", "aria-orientation": "vertical", "aria-label": `Resize ${AI_LABEL} column`, className: `records-resize-handle ${resizingColumn === "ai" ? "is-resizing" : ""}`, onPointerDown: startColumnResize("ai") })
            ] }),
            /* @__PURE__ */ jsx18("th", { className: "records-header-cell", children: /* @__PURE__ */ jsxs15("div", { className: "flex h-[35px] items-center gap-1 px-2", children: [
              /* @__PURE__ */ jsx18(
                "button",
                {
                  type: "button",
                  "aria-label": "New property",
                  "data-recpop": true,
                  onClick: (event) => {
                    setProp(null);
                    setTableMenuOpen(null);
                    const rect = event.currentTarget.getBoundingClientRect();
                    setAddOpen((current) => current ? null : { x: Math.min(rect.left, window.innerWidth - 276), y: rect.bottom + 6 });
                  },
                  className: "flex size-7 items-center justify-center rounded-[7px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink",
                  children: /* @__PURE__ */ jsx18(Icon2, { size: 15, strokeWidth: 2, children: /* @__PURE__ */ jsx18("path", { d: "M12 5v14M5 12h14" }) })
                }
              ),
              /* @__PURE__ */ jsx18(
                "button",
                {
                  type: "button",
                  "aria-label": "Table options",
                  "aria-expanded": !!tableMenuOpen,
                  "data-recpop": true,
                  onClick: (event) => {
                    setProp(null);
                    setAddOpen(null);
                    const rect = event.currentTarget.getBoundingClientRect();
                    setTableMenuOpen((current) => current ? null : {
                      x: Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228)),
                      y: rect.bottom + 6
                    });
                  },
                  className: "flex size-7 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink",
                  children: /* @__PURE__ */ jsxs15("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": true, children: [
                    /* @__PURE__ */ jsx18("circle", { cx: "5", cy: "12", r: "1.6" }),
                    /* @__PURE__ */ jsx18("circle", { cx: "12", cy: "12", r: "1.6" }),
                    /* @__PURE__ */ jsx18("circle", { cx: "19", cy: "12", r: "1.6" })
                  ] })
                }
              )
            ] }) })
          ] }) }),
          /* @__PURE__ */ jsx18("tbody", { "data-sound-silent": true, children: visibleRows.map((row, index) => {
            const selectedRow = selected.has(row.id);
            const strength = STRENGTH[row.strength];
            return /* @__PURE__ */ jsxs15("tr", { className: `records-row ${selectedRow ? "is-selected" : ""}`, children: [
              /* @__PURE__ */ jsxs15("td", { className: `records-cell records-sticky-cell records-company-cell ${prop?.col === "Record" ? "is-colsel" : ""}`, children: [
                /* @__PURE__ */ jsx18("span", { className: "records-rownum", children: index + 1 }),
                /* @__PURE__ */ jsx18(Checkbox, { checked: selectedRow, onChange: () => toggleRow(row.id), label: `Select ${row.name}` }),
                /* @__PURE__ */ jsx18("span", { className: "records-company-mark", children: row.name.slice(0, 1).toUpperCase() }),
                /* @__PURE__ */ jsx18("button", { type: "button", disabled: !onOpenRow, onClick: () => onOpenRow?.(row), title: row.name, className: "records-company-name", children: row.name })
              ] }),
              /* @__PURE__ */ jsx18("td", { className: `records-cell ${prop?.col === "Type" ? "is-colsel" : ""}`, children: isCalc("Type", index) ? /* @__PURE__ */ jsx18(CalcCell, {}) : /* @__PURE__ */ jsx18(TagList, { tags: row.tags }) }),
              /* @__PURE__ */ jsx18("td", { className: `records-cell ${row.last === "No contact" ? "records-muted" : ""} ${prop?.col === "Last updated" ? "is-colsel" : ""}`, children: isCalc("Last updated", index) ? /* @__PURE__ */ jsx18(CalcCell, {}) : row.last }),
              /* @__PURE__ */ jsx18("td", { className: `records-cell ${prop?.col === "Evidence coverage" ? "is-colsel" : ""}`, children: isCalc("Evidence coverage", index) ? /* @__PURE__ */ jsx18(CalcCell, {}) : /* @__PURE__ */ jsxs15("span", { className: "records-strength", children: [
                /* @__PURE__ */ jsx18("span", { className: "records-strength-dot", style: { background: strength.color } }),
                strength.label
              ] }) }),
              /* @__PURE__ */ jsx18("td", { className: `records-cell ${prop?.col === "Links" ? "is-colsel" : ""}`, children: isCalc("Links", index) ? /* @__PURE__ */ jsx18(CalcCell, {}) : row.website ? /* @__PURE__ */ jsxs15("a", { className: "records-link", href: `https://${row.website}`, title: row.website, target: "_blank", rel: "noreferrer", children: [
                /* @__PURE__ */ jsx18("span", { className: "records-link-label", children: row.website }),
                /* @__PURE__ */ jsx18(Icon2, { size: 12, children: /* @__PURE__ */ jsx18("path", { d: "M14 5h5v5M19 5l-8 8" }) })
              ] }) : /* @__PURE__ */ jsx18("span", { className: "records-muted", children: "\u2014" }) }),
              aiAdded && /* @__PURE__ */ jsx18("td", { className: `records-cell ${prop?.col === AI_LABEL ? "is-colsel" : ""}`, children: calc?.col === AI_LABEL ? index < calc.resolved ? values[row.id] ?? row.reviewGap ?? "Not assessed" : /* @__PURE__ */ jsx18(CalcCell, {}) : aiDone ? values[row.id] ?? row.reviewGap ?? "Not assessed" : /* @__PURE__ */ jsx18("span", { className: "records-muted", children: "\u2014" }) }),
              /* @__PURE__ */ jsx18("td", { className: "records-cell" })
            ] }, row.id);
          }) }),
          /* @__PURE__ */ jsx18("tfoot", { children: /* @__PURE__ */ jsxs15("tr", { className: "records-calculation-row", children: [
            /* @__PURE__ */ jsx18("td", { className: "records-cell records-sticky-cell", children: /* @__PURE__ */ jsxs15("span", { className: "records-footer-value records-calculation-label", children: [
              /* @__PURE__ */ jsx18("span", { className: "records-calculation-number", children: rows.length }),
              " count"
            ] }) }),
            /* @__PURE__ */ jsx18("td", { className: "records-cell", children: /* @__PURE__ */ jsxs15("button", { type: "button", className: "records-add-calculation", onClick: (event) => {
              setAiAdded(true);
              setPendingOpenAi(true);
              setColumnOverrides((current) => ({ ...current, [AI_LABEL]: { type: "Text" } }));
              event.stopPropagation();
            }, children: [
              /* @__PURE__ */ jsx18(Icon2, { size: 15, children: /* @__PURE__ */ jsx18("path", { d: "M12 5v14M5 12h14" }) }),
              "Add calculation"
            ] }) }),
            /* @__PURE__ */ jsx18("td", { className: "records-cell records-muted", children: /* @__PURE__ */ jsx18("span", { className: "records-footer-value", children: "\u2014" }) }),
            /* @__PURE__ */ jsx18("td", { className: "records-cell", children: /* @__PURE__ */ jsxs15("span", { className: "records-footer-value records-average", children: [
              /* @__PURE__ */ jsx18("span", { className: "records-strength-dot", style: { background: "var(--orange)" } }),
              rows.filter((row) => row.strength === "strong").length,
              " ",
              rows.filter((row) => row.strength === "strong").length === 1 ? "source" : "sources",
              " checked"
            ] }) }),
            /* @__PURE__ */ jsx18("td", { className: "records-cell", children: /* @__PURE__ */ jsxs15("span", { className: "records-footer-value records-muted", children: [
              rows.filter((row) => row.website).length,
              " links"
            ] }) }),
            aiAdded && /* @__PURE__ */ jsx18("td", { className: "records-cell records-muted", children: /* @__PURE__ */ jsx18("span", { className: "records-footer-value", children: aiDone ? `${rows.length} filled` : "\u2014" }) }),
            /* @__PURE__ */ jsx18("td", { className: "records-cell" })
          ] }) })
        ] })
      }
    ),
    prop && meta && /* @__PURE__ */ jsxs15(
      "div",
      {
        "data-recpop": true,
        className: "fixed z-50 w-[320px] rounded-[14px] bg-surface px-3 pt-3 pb-1.5 shadow-overlay",
        style: { ...menuBounds(prop.x, prop.y, 320, moreSettingsOpen ? 580 : 440), animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" },
        children: [
          /* @__PURE__ */ jsx18("div", { className: "pb-2 text-[13.5px] font-medium text-ink", children: prop.col }),
          /* @__PURE__ */ jsxs15(ConfigRow, { label: "Type", children: [
            /* @__PURE__ */ jsxs15(
              "button",
              {
                type: "button",
                "aria-haspopup": "menu",
                "aria-expanded": configMenu === "type",
                onClick: () => setConfigMenu((current) => current === "type" ? null : "type"),
                className: "flex items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[13px] font-medium text-ink transition-colors duration-100 hover:bg-hover",
                children: [
                  /* @__PURE__ */ jsx18("span", { className: "text-ink-2", children: /* @__PURE__ */ jsx18(Icon2, { size: 14, children: TYPE_GLYPHS[meta.type] ?? TYPE_GLYPHS.Text }) }),
                  meta.type,
                  /* @__PURE__ */ jsx18("span", { className: "text-ink-3", children: /* @__PURE__ */ jsx18(Icon2, { size: 12, strokeWidth: 2.2, children: /* @__PURE__ */ jsx18("path", { d: "M9 6l6 6-6 6" }) }) })
                ]
              }
            ),
            configMenu === "type" && /* @__PURE__ */ jsx18(
              ConfigPicker,
              {
                label: "Property type",
                selected: meta.type,
                options: NEW_PROPERTY_TYPES.map((type) => ({ label: type, icon: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: TYPE_GLYPHS[type] }) })),
                onSelect: (type) => {
                  setColumnOverrides((current) => ({ ...current, [prop.col]: { ...current[prop.col], type } }));
                  setConfigMenu(null);
                }
              }
            )
          ] }),
          /* @__PURE__ */ jsxs15(ConfigRow, { label: "Tool", children: [
            /* @__PURE__ */ jsxs15(
              "button",
              {
                type: "button",
                "aria-haspopup": "menu",
                "aria-expanded": configMenu === "tool",
                onClick: () => setConfigMenu((current) => current === "tool" ? null : "tool"),
                className: "flex items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[13px] font-medium text-ink transition-colors duration-100 hover:bg-hover",
                children: [
                  /* @__PURE__ */ jsx18("span", { className: meta.toolKind === "model" ? "text-accent" : "text-ink-2", children: meta.toolKind === "model" ? /* @__PURE__ */ jsx18("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": true, children: TOOL_GLYPHS.model }) : /* @__PURE__ */ jsx18(Icon2, { size: 14, children: TOOL_GLYPHS[meta.toolKind] }) }),
                  meta.tool,
                  /* @__PURE__ */ jsx18("span", { className: "text-ink-3", children: /* @__PURE__ */ jsx18(Icon2, { size: 12, strokeWidth: 2.2, children: /* @__PURE__ */ jsx18("path", { d: "M9 6l6 6-6 6" }) }) })
                ]
              }
            ),
            configMenu === "tool" && /* @__PURE__ */ jsx18(
              ConfigPicker,
              {
                label: "Model",
                selected: meta.tool,
                options: MODEL_OPTIONS.map((model) => ({
                  label: model,
                  icon: /* @__PURE__ */ jsx18("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": true, children: TOOL_GLYPHS.model })
                })),
                onSelect: (tool) => {
                  setColumnOverrides((current) => ({ ...current, [prop.col]: { ...current[prop.col], tool, toolKind: "model" } }));
                  setConfigMenu(null);
                }
              }
            )
          ] }),
          /* @__PURE__ */ jsxs15(ConfigRow, { label: "Grounding", children: [
            /* @__PURE__ */ jsxs15("span", { className: "flex items-center gap-2", children: [
              /* @__PURE__ */ jsx18(MiniSwitch, { label: "Grounding", on: grounding, onToggle: () => setGrounding((current) => !current) }),
              /* @__PURE__ */ jsx18(
                "button",
                {
                  type: "button",
                  "aria-label": "About grounding",
                  "aria-expanded": groundingHelpOpen,
                  onClick: () => setGroundingHelpOpen((open) => !open),
                  className: "flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink",
                  children: /* @__PURE__ */ jsx18(Icon2, { size: 13, children: /* @__PURE__ */ jsxs15("g", { children: [
                    /* @__PURE__ */ jsx18("circle", { cx: "12", cy: "12", r: "9" }),
                    /* @__PURE__ */ jsx18("path", { d: "M12 8h.01M11 12h1v4h1" })
                  ] }) })
                }
              )
            ] }),
            groundingHelpOpen && /* @__PURE__ */ jsx18("div", { className: "absolute right-0 top-[30px] z-30 w-[230px] rounded-[10px] px-3 py-2.5 text-[12px] leading-relaxed shadow-overlay", style: { color: "var(--tooltip-fg)", background: "var(--tooltip-bg)" }, role: "status", children: "Grounding requests citations from selected sources. It does not prove a claim is true." })
          ] }),
          /* @__PURE__ */ jsxs15(ConfigRow, { label: "Inputs", children: [
            /* @__PURE__ */ jsxs15(
              "button",
              {
                type: "button",
                "aria-haspopup": "menu",
                "aria-expanded": configMenu === "inputs",
                onClick: () => setConfigMenu((current) => current === "inputs" ? null : "inputs"),
                className: "flex max-w-[220px] items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[13px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink",
                children: [
                  selectedInputs.length ? /* @__PURE__ */ jsxs15("span", { className: "flex min-w-0 items-center gap-1", children: [
                    selectedInputs.slice(0, 2).map((input) => /* @__PURE__ */ jsx18("span", { className: "max-w-[92px] truncate rounded-[5px] bg-accent-tint px-1.5 py-0.5 text-[12px] font-medium text-accent-ink", children: input }, input)),
                    selectedInputs.length > 2 && /* @__PURE__ */ jsxs15("span", { className: "text-[11px] font-medium text-ink-3", children: [
                      "+",
                      selectedInputs.length - 2
                    ] })
                  ] }) : /* @__PURE__ */ jsx18("span", { children: "Select inputs" }),
                  /* @__PURE__ */ jsx18("span", { className: "shrink-0 text-ink-3", children: /* @__PURE__ */ jsx18(Icon2, { size: 12, strokeWidth: 2.2, children: /* @__PURE__ */ jsx18("path", { d: "M9 6l6 6-6 6" }) }) })
                ]
              }
            ),
            configMenu === "inputs" && /* @__PURE__ */ jsx18(
              InputPicker,
              {
                selected: selectedInputs,
                options: INPUT_OPTIONS.filter((input) => input !== prop.col),
                onToggle: (input) => {
                  setInputSelections((current) => {
                    const existing = current[prop.col] ?? (meta.inputs ? [meta.inputs] : []);
                    const next = existing.includes(input) ? existing.filter((item) => item !== input) : [...existing, input];
                    return { ...current, [prop.col]: next };
                  });
                }
              }
            )
          ] }),
          /* @__PURE__ */ jsx18(
            "div",
            {
              ref: promptRef,
              contentEditable: true,
              suppressContentEditableWarning: true,
              role: "textbox",
              "aria-label": `${prop.col} calculation prompt`,
              "aria-multiline": "true",
              spellCheck: true,
              className: "mt-2 min-h-[88px] cursor-text rounded-[10px] bg-inset p-3 text-[13px] leading-relaxed shadow-hairline outline-none transition-[box-shadow] duration-150 focus:shadow-[0_0_0_2px_var(--accent)]",
              children: meta.prompt ? /* @__PURE__ */ jsxs15("span", { className: "text-ink", children: [
                meta.prompt.before,
                meta.prompt.chip && /* @__PURE__ */ jsx18("span", { contentEditable: false, className: "rounded-[5px] bg-accent-tint px-1.5 py-0.5 text-[12px] font-medium text-accent-ink", children: meta.prompt.chip }),
                meta.prompt.after
              ] }) : /* @__PURE__ */ jsx18("span", { className: "text-ink-3", children: "Set a prompt (press @ to mention an input)" })
            }
          ),
          /* @__PURE__ */ jsxs15(
            "button",
            {
              type: "button",
              disabled: !!calc || calculating,
              onClick: async () => {
                if (calculating || calc) return;
                const id = ++requestId.current;
                const column = prop.col;
                setCalculating(true);
                setCalculationError("");
                try {
                  const next = onCalculate ? await onCalculate({ column, rows, prompt: promptRef.current?.textContent ?? "", inputs: selectedInputs, model: meta.tool, grounding, type: meta.type, required: advancedSettings.required, allowEmpty: advancedSettings.allowEmpty, showSourceCoverage: advancedSettings.confidence }) : Object.fromEntries(rows.map((row) => [row.id, row.reviewGap ?? "Not assessed"]));
                  if (id !== requestId.current) return;
                  setValues(next);
                  setCalc({ col: column, resolved: 0 });
                  setProp(null);
                } catch {
                  if (id === requestId.current) setCalculationError("Could not read results. Try again.");
                } finally {
                  if (id === requestId.current) setCalculating(false);
                }
              },
              className: "mt-2.5 flex h-9 w-full items-center justify-center gap-2 rounded-[9px] text-[12.5px] font-medium text-ink shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.98] disabled:opacity-60",
              children: [
                /* @__PURE__ */ jsx18(Icon2, { size: 14, strokeWidth: 1.9, children: /* @__PURE__ */ jsx18("path", { d: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" }) }),
                calculating ? "Reading\u2026" : onCalculate ? "Run with Iris" : "Preview sample results"
              ]
            }
          ),
          calculationError && /* @__PURE__ */ jsx18("p", { role: "alert", className: "mt-2 text-[12px] text-red", children: calculationError }),
          /* @__PURE__ */ jsxs15(GlideMenu, { className: "mt-3 flex flex-col gap-0.5 border-t border-line pt-2", highlightClassName: "-inset-x-1.5 rounded-[8px] bg-hover", children: [
            /* @__PURE__ */ jsxs15(
              "button",
              {
                "data-menu-row": true,
                type: "button",
                "aria-pressed": pinnedColumns.has(prop.col),
                onClick: () => setPinnedColumns((current) => {
                  const next = new Set(current);
                  next.has(prop.col) ? next.delete(prop.col) : next.add(prop.col);
                  return next;
                }),
                className: "relative z-10 -mx-1.5 flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[13px] leading-none text-ink transition-transform duration-150 active:scale-[0.96]",
                children: [
                  /* @__PURE__ */ jsx18("span", { className: pinnedColumns.has(prop.col) ? "text-accent" : "text-ink-2", children: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: /* @__PURE__ */ jsx18("path", { d: "M12 17v5M8 3h8l-1 7 3 3H6l3-3-1-7z" }) }) }),
                  pinnedColumns.has(prop.col) ? "Unpin" : "Pin"
                ]
              }
            ),
            /* @__PURE__ */ jsxs15(
              "button",
              {
                "data-menu-row": true,
                type: "button",
                "aria-expanded": moreSettingsOpen,
                onClick: () => setMoreSettingsOpen((open) => !open),
                className: "relative z-10 -mx-1.5 flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[13px] leading-none text-ink transition-transform duration-150 active:scale-[0.96]",
                children: [
                  /* @__PURE__ */ jsx18("span", { className: moreSettingsOpen ? "text-ink" : "text-ink-2", children: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: /* @__PURE__ */ jsxs15("g", { children: [
                    /* @__PURE__ */ jsx18("circle", { cx: "12", cy: "12", r: "3" }),
                    /* @__PURE__ */ jsx18("path", { d: "M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" })
                  ] }) }) }),
                  /* @__PURE__ */ jsx18("span", { className: "flex-1", children: "More settings" }),
                  /* @__PURE__ */ jsx18("span", { className: `text-ink-3 transition-transform duration-150 ${moreSettingsOpen ? "rotate-90" : ""}`, children: /* @__PURE__ */ jsx18(Icon2, { size: 12, strokeWidth: 2.2, children: /* @__PURE__ */ jsx18("path", { d: "M9 6l6 6-6 6" }) }) })
                ]
              }
            ),
            prop.col === AI_LABEL && /* @__PURE__ */ jsxs15(
              "button",
              {
                "data-menu-row": true,
                type: "button",
                onClick: () => {
                  setAiAdded(false);
                  setAiDone(false);
                  setProp(null);
                },
                className: "relative z-10 -mx-1.5 flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[13px] leading-none text-ink transition-transform duration-150 active:scale-[0.96]",
                children: [
                  /* @__PURE__ */ jsx18("span", { className: "text-ink-2", children: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: /* @__PURE__ */ jsxs15("g", { children: [
                    /* @__PURE__ */ jsx18("path", { d: "M10.6 5.1A9.8 9.8 0 0 1 12 5c7 0 10 7 10 7a16.3 16.3 0 0 1-2.1 3M6.6 6.6A16 16 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6M3 3l18 18" }),
                    /* @__PURE__ */ jsx18("path", { d: "M9.9 9.9a3 3 0 0 0 4.2 4.2" })
                  ] }) }) }),
                  "Hide from view"
                ]
              }
            )
          ] }),
          moreSettingsOpen && /* @__PURE__ */ jsxs15("div", { className: "mt-2 border-t border-line pt-2", style: { animation: "fade-up 160ms cubic-bezier(0.23,1,0.32,1) both" }, children: [
            /* @__PURE__ */ jsx18("div", { className: "pb-1 text-[11.5px] font-medium text-ink-3", children: "Behavior" }),
            /* @__PURE__ */ jsx18(ConfigRow, { label: "Required value", children: /* @__PURE__ */ jsx18(MiniSwitch, { label: "Required value", on: advancedSettings.required, onToggle: () => setAdvancedSettings((current) => ({ ...current, required: !current.required })) }) }),
            /* @__PURE__ */ jsx18(ConfigRow, { label: "Allow empty results", children: /* @__PURE__ */ jsx18(MiniSwitch, { label: "Allow empty results", on: advancedSettings.allowEmpty, onToggle: () => setAdvancedSettings((current) => ({ ...current, allowEmpty: !current.allowEmpty })) }) }),
            /* @__PURE__ */ jsx18(ConfigRow, { label: "Show source coverage", children: /* @__PURE__ */ jsx18(MiniSwitch, { label: "Show source coverage", on: advancedSettings.confidence, onToggle: () => setAdvancedSettings((current) => ({ ...current, confidence: !current.confidence })) }) })
          ] })
        ]
      }
    ),
    addOpen && /* @__PURE__ */ jsxs15(
      "div",
      {
        "data-recpop": true,
        className: "fixed z-50 w-[260px] rounded-[14px] bg-surface p-1.5 shadow-overlay",
        style: { ...menuBounds(addOpen.x, addOpen.y, 260, 390), animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" },
        children: [
          /* @__PURE__ */ jsx18("div", { className: "px-2 pb-1 pt-1 text-[12px] font-medium text-ink-3", children: "New property" }),
          /* @__PURE__ */ jsx18(GlideMenu, { className: "flex flex-col gap-px", children: NEW_PROPERTY_TYPES.map((type) => /* @__PURE__ */ jsxs15(
            "button",
            {
              "data-menu-row": true,
              type: "button",
              onClick: () => {
                setColumnOverrides((current) => ({ ...current, [AI_LABEL]: { ...current[AI_LABEL], type } }));
                setAddOpen(null);
                setAiDone(false);
                setAiAdded(true);
                setPendingOpenAi(true);
              },
              className: "relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink",
              children: [
                /* @__PURE__ */ jsx18("span", { className: "text-ink-2", children: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: TYPE_GLYPHS[type] }) }),
                type
              ]
            },
            type
          )) })
        ]
      }
    ),
    tableMenuOpen && /* @__PURE__ */ jsxs15(
      "div",
      {
        "data-recpop": true,
        className: "fixed z-50 w-[220px] rounded-[14px] bg-surface p-1.5 shadow-overlay",
        style: { ...menuBounds(tableMenuOpen.x, tableMenuOpen.y, 220, 235), animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" },
        children: [
          /* @__PURE__ */ jsx18("div", { className: "px-2 pb-1 pt-1 text-[12px] font-medium text-ink-3", children: "Table options" }),
          /* @__PURE__ */ jsxs15(GlideMenu, { className: "flex flex-col gap-px", children: [
            /* @__PURE__ */ jsxs15(
              "button",
              {
                "data-menu-row": true,
                type: "button",
                onClick: () => {
                  const position = tableMenuOpen;
                  setTableMenuOpen(null);
                  setAddOpen({ x: Math.min(position.x, window.innerWidth - 276), y: position.y });
                },
                className: "relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink",
                children: [
                  /* @__PURE__ */ jsx18("span", { className: "text-ink-2", children: /* @__PURE__ */ jsx18(Icon2, { size: 15, strokeWidth: 2, children: /* @__PURE__ */ jsx18("path", { d: "M12 5v14M5 12h14" }) }) }),
                  "Add property"
                ]
              }
            ),
            /* @__PURE__ */ jsxs15(
              "button",
              {
                "data-menu-row": true,
                type: "button",
                onClick: () => {
                  setColumnWidths({ company: 220, categories: 220, last: 155, strength: 180, links: 160, ai: 200 });
                  setTableMenuOpen(null);
                },
                className: "relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink",
                children: [
                  /* @__PURE__ */ jsx18("span", { className: "text-ink-2", children: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: /* @__PURE__ */ jsx18("path", { d: "M4 8h16M7 4 3 8l4 4M17 4l4 4-4 4M4 16h16" }) }) }),
                  "Compact columns"
                ]
              }
            ),
            /* @__PURE__ */ jsxs15(
              "button",
              {
                "data-menu-row": true,
                type: "button",
                onClick: () => {
                  setColumnWidths({ ...initialColumnWidthsRef.current ?? DEFAULT_COLUMN_WIDTHS });
                  setTableMenuOpen(null);
                },
                className: "relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink",
                children: [
                  /* @__PURE__ */ jsx18("span", { className: "text-ink-2", children: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: /* @__PURE__ */ jsx18("path", { d: "M3 12a9 9 0 1 0 3-6.7M3 4v6h6" }) }) }),
                  "Reset column widths"
                ]
              }
            ),
            /* @__PURE__ */ jsx18("div", { className: "my-1 h-px bg-line" }),
            /* @__PURE__ */ jsxs15(
              "button",
              {
                "data-menu-row": true,
                type: "button",
                onClick: () => {
                  setSelected(/* @__PURE__ */ new Set());
                  onSelectionChange?.([]);
                  setTableMenuOpen(null);
                },
                className: "relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink",
                children: [
                  /* @__PURE__ */ jsx18("span", { className: "text-ink-2", children: /* @__PURE__ */ jsx18(Icon2, { size: 15, children: /* @__PURE__ */ jsx18("path", { d: "M5 5l14 14M19 5 5 19" }) }) }),
                  "Clear selection"
                ]
              }
            )
          ] })
        ]
      }
    )
  ] });
}

// src/components/primitives/FilterTable.tsx
import { useState as useState16 } from "react";
import { jsx as jsx19, jsxs as jsxs16 } from "react/jsx-runtime";
var FILTERS = [
  { key: "all", label: "All" },
  { key: "todo", label: "Needs review", dot: "#f09a2f" },
  { key: "progress", label: "Working", dot: "#16a6c7" },
  { key: "done", label: "Completed", dot: "#25a878" }
];
var PROGRAM_TASKS = [
  { task: "Leah application", date: "Oct 12", status: "todo", owner: "Maya Chen" },
  { task: "Owen application", date: "Oct 12", status: "todo", owner: "Maya Chen" },
  { task: "Robin invoice", date: "Oct 12", status: "todo", owner: "Maya Chen" },
  { task: "Services agreement", date: "Oct 12", status: "todo", owner: "Maya Chen" },
  { task: "Compare report gaps", date: "Oct 12", status: "progress", owner: "Iris" },
  { task: "Read program sources", date: "Oct 12", status: "done", owner: "Iris" }
];
var LABELS = {
  columns: { task: "Work", date: "Date", status: "Status", owner: "Owner" }
};
var PILLS = {
  todo: { label: "Needs review", cls: "filter-status-todo" },
  progress: { label: "Working", cls: "filter-status-progress" },
  done: { label: "Completed", cls: "filter-status-done" }
};
function FilterTable({
  rows = PROGRAM_TASKS,
  labels = LABELS,
  initialFilter = "all",
  onFilterChange,
  onOpenRow
} = {}) {
  const [filter, setFilter] = useState16(initialFilter);
  const reduce = useReducedMotion();
  return /* @__PURE__ */ jsxs16("div", { "data-reduced-motion": reduce, className: "hermes-ui w-full max-w-105", children: [
    /* @__PURE__ */ jsx19(
      "div",
      {
        className: "-mx-1 mb-1 flex flex-wrap items-center gap-1 px-1 py-1",
        children: FILTERS.map((f) => {
          const active = filter === f.key;
          return /* @__PURE__ */ jsxs16(
            "button",
            {
              type: "button",
              "aria-pressed": active,
              onClick: () => {
                setFilter(f.key);
                onFilterChange?.(f.key);
              },
              className: `flex h-6.5 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px]
                font-medium transition-[background-color,box-shadow,color] duration-200
                ${active ? "bg-surface text-ink shadow-btn" : "text-ink-2 hover:bg-hover"}`,
              children: [
                f.dot && /* @__PURE__ */ jsx19("span", { className: "size-1.5 rounded-full", style: { background: f.dot } }),
                f.label,
                /* @__PURE__ */ jsx19(
                  "span",
                  {
                    className: `rounded-[4px] px-1 text-[10.5px] tabular-nums
                  ${active ? "bg-field text-ink-2" : "text-ink-3"}`,
                    children: f.key === "all" ? rows.length : rows.filter((r) => r.status === f.key).length
                  }
                )
              ]
            },
            f.key
          );
        })
      }
    ),
    /* @__PURE__ */ jsx19(
      "div",
      {
        "aria-label": "Scrollable task table",
        className: "overflow-x-auto rounded-card bg-surface shadow-card",
        role: "region",
        tabIndex: 0,
        style: { scrollbarWidth: "none" },
        children: /* @__PURE__ */ jsxs16("div", { className: "min-w-[420px]", children: [
          /* @__PURE__ */ jsxs16("div", { className: "grid grid-cols-[minmax(0,1.3fr)_minmax(0,0.75fr)_minmax(0,1.2fr)_minmax(0,1fr)] border-b border-[var(--grid-line)] text-[12.5px] font-medium text-ink-2", children: [
            /* @__PURE__ */ jsx19("span", { className: "border-r border-[var(--grid-line)] px-2 py-2", children: labels.columns.task }),
            /* @__PURE__ */ jsx19("span", { className: "border-r border-[var(--grid-line)] px-2 py-2", children: labels.columns.date }),
            /* @__PURE__ */ jsx19("span", { className: "border-r border-[var(--grid-line)] px-2 py-2", children: labels.columns.status }),
            /* @__PURE__ */ jsx19("span", { className: "px-2 py-2", children: labels.columns.owner })
          ] }),
          rows.map((row) => {
            const shown = filter === "all" || row.status === filter;
            const pill = PILLS[row.status];
            return /* @__PURE__ */ jsx19(
              "div",
              {
                inert: !shown,
                "aria-hidden": !shown,
                className: "grid transition-[grid-template-rows,opacity] duration-300",
                style: {
                  gridTemplateRows: shown ? "1fr" : "0fr",
                  opacity: shown ? 1 : 0,
                  transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)"
                },
                children: /* @__PURE__ */ jsx19("div", { className: "overflow-hidden", children: /* @__PURE__ */ jsxs16(
                  "div",
                  {
                    className: "grid grid-cols-[minmax(0,1.3fr)_minmax(0,0.75fr)_minmax(0,1.2fr)_minmax(0,1fr)] border-b\n                      border-[var(--grid-line)] text-[13px] transition-colors duration-100 hover:bg-hover",
                    children: [
                      /* @__PURE__ */ jsx19("span", { className: "flex min-w-0 items-center border-r border-[var(--grid-line)] px-2 py-2", children: /* @__PURE__ */ jsx19("button", { type: "button", disabled: !onOpenRow, onClick: () => onOpenRow?.(row), className: "min-w-0 whitespace-normal [overflow-wrap:anywhere] text-left font-medium text-ink", title: row.task, children: row.task }) }),
                      /* @__PURE__ */ jsx19("span", { className: "flex min-w-0 items-center whitespace-normal [overflow-wrap:anywhere] border-r border-[var(--grid-line)] px-2 py-2 text-ink-2 tabular-nums", children: row.date }),
                      /* @__PURE__ */ jsx19("span", { className: "flex min-w-0 items-center border-r border-[var(--grid-line)] px-2 py-2", children: /* @__PURE__ */ jsx19(
                        "span",
                        {
                          className: `inline-flex min-h-[23px] min-w-0 max-w-full items-center whitespace-normal [overflow-wrap:anywhere] rounded-[8px] border px-[7px] py-px
                          text-[13px] font-medium ${pill.cls}`,
                          children: pill.label
                        }
                      ) }),
                      /* @__PURE__ */ jsx19("span", { className: "flex min-w-0 items-center px-2 py-2 text-ink-2", children: /* @__PURE__ */ jsx19("span", { className: "min-w-0 whitespace-normal [overflow-wrap:anywhere]", children: row.owner }) })
                    ]
                  }
                ) })
              },
              row.task
            );
          })
        ] })
      }
    )
  ] });
}

// src/components/primitives/SidebarNav.tsx
import { useEffect as useEffect14, useRef as useRef12, useState as useState17 } from "react";
import { createPortal as createPortal4 } from "react-dom";
import { jsx as jsx20, jsxs as jsxs17 } from "react/jsx-runtime";
var IRIS_ASSET = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22face%22%20x1%3D%2210%22%20y1%3D%227%22%20x2%3D%2249%22%20y2%3D%2260%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%23FFFFFF%22/%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23E9E6F6%22/%3E%3Cstop%20offset%3D%22.72%22%20stop-color%3D%22%23BDB7D8%22/%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23716B96%22/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg%20opacity%3D%22.2%22%20transform%3D%22translate%280%203%29%22%3E%3Cpath%20d%3D%22M32%209C38%209%2042%2017%2038%2024C45%2020%2053%2024%2053%2031C53%2038%2045%2042%2038%2038C42%2045%2038%2053%2031%2053C24%2053%2020%2045%2024%2038C17%2042%209%2038%209%2031C9%2024%2017%2020%2024%2024C20%2017%2024%209%2032%209Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M32%2010C36%2010%2040%2015%2039%2021L32%2030%2025%2023C22%2017%2025%2010%2032%2010Z%22%20fill%3D%22%23FFF%22%20opacity%3D%22.72%22/%3E%3Cpath%20d%3D%22M33%2032%2048%2026C55%2034%2046%2042%2039%2038L34%2049%2028%2038Z%22%20fill%3D%22%239E9ABF%22%20opacity%3D%22.38%22/%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2231%22%20r%3D%226%22%20fill%3D%22%2326214C%22/%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2230%22%20r%3D%225%22%20fill%3D%22%23181333%22/%3E%3C/g%3E%3Cpath%20d%3D%22M32%209C38%209%2042%2017%2038%2024C45%2020%2053%2024%2053%2031C53%2038%2045%2042%2038%2038C42%2045%2038%2053%2031%2053C24%2053%2020%2045%2024%2038C17%2042%209%2038%209%2031C9%2024%2017%2020%2024%2024C20%2017%2024%209%2032%209Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M32%2010C36%2010%2040%2015%2039%2021L32%2030%2025%2023C22%2017%2025%2010%2032%2010Z%22%20fill%3D%22%23FFF%22%20opacity%3D%22.72%22/%3E%3Cpath%20d%3D%22M33%2032%2048%2026C55%2034%2046%2042%2039%2038L34%2049%2028%2038Z%22%20fill%3D%22%239E9ABF%22%20opacity%3D%22.38%22/%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2231%22%20r%3D%226%22%20fill%3D%22%2326214C%22/%3E%3Ccircle%20cx%3D%2231%22%20cy%3D%2230%22%20r%3D%225%22%20fill%3D%22%23181333%22/%3E%3C/svg%3E";
var SKILL_ASSET = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22face%22%20x1%3D%2210%22%20y1%3D%227%22%20x2%3D%2249%22%20y2%3D%2260%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%23FFFFFF%22/%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23E9E6F6%22/%3E%3Cstop%20offset%3D%22.72%22%20stop-color%3D%22%23BDB7D8%22/%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23716B96%22/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg%20opacity%3D%22.2%22%20transform%3D%22translate%280%203%29%22%3E%3Cpath%20d%3D%22m32%203%209%2020%2020%209-20%209-9%2020-9-20L3%2032l20-9Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22m32%203%200%2029L3%2032l20-9Z%22%20fill%3D%22%23FFF%22%20opacity%3D%22.8%22/%3E%3Cpath%20d%3D%22m32%2032%2029%200-20%209-9%2020Z%22%20fill%3D%22%238B86AD%22%20opacity%3D%22.54%22/%3E%3Cpath%20d%3D%22m32%2032%209-9%2020%209Z%22%20fill%3D%22%23F9F6FF%22%20opacity%3D%22.7%22/%3E%3C/g%3E%3Cpath%20d%3D%22m32%203%209%2020%2020%209-20%209-9%2020-9-20L3%2032l20-9Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22m32%203%200%2029L3%2032l20-9Z%22%20fill%3D%22%23FFF%22%20opacity%3D%22.8%22/%3E%3Cpath%20d%3D%22m32%2032%2029%200-20%209-9%2020Z%22%20fill%3D%22%238B86AD%22%20opacity%3D%22.54%22/%3E%3Cpath%20d%3D%22m32%2032%209-9%2020%209Z%22%20fill%3D%22%23F9F6FF%22%20opacity%3D%22.7%22/%3E%3C/svg%3E";
var INBOX_ASSET = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22face%22%20x1%3D%2210%22%20y1%3D%227%22%20x2%3D%2249%22%20y2%3D%2260%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20stop-color%3D%22%23FFFFFF%22/%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23E9E6F6%22/%3E%3Cstop%20offset%3D%22.72%22%20stop-color%3D%22%23BDB7D8%22/%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23716B96%22/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg%20opacity%3D%22.2%22%20transform%3D%22translate%280%203%29%22%3E%3Cpath%20d%3D%22M15%2013h34l10%2027v17H5V40Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M15%2013h34l8%2024H40l-4%207h-8l-4-7H7Z%22%20fill%3D%22%23D2CDE7%22/%3E%3Cpath%20d%3D%22M5%2040h19l4%207h8l4-7h19v17H5Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M15%2014h34%22%20stroke%3D%22%23FFF%22%20stroke-width%3D%222%22/%3E%3C/g%3E%3Cpath%20d%3D%22M15%2013h34l10%2027v17H5V40Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M15%2013h34l8%2024H40l-4%207h-8l-4-7H7Z%22%20fill%3D%22%23D2CDE7%22/%3E%3Cpath%20d%3D%22M5%2040h19l4%207h8l4-7h19v17H5Z%22%20fill%3D%22url%28%23face%29%22/%3E%3Cpath%20d%3D%22M15%2014h34%22%20stroke%3D%22%23FFF%22%20stroke-width%3D%222%22/%3E%3C/svg%3E";
function Glyph({ path, size = 18, className = "" }) {
  return /* @__PURE__ */ jsx20("svg", { width: size, height: size, className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: /* @__PURE__ */ jsx20("path", { d: path }) });
}
var IconCheckmark1Small = (props) => /* @__PURE__ */ jsx20(Glyph, { ...props, path: "m5 12 4 4 10-10" });
var IconChevronDownSmall = (props) => /* @__PURE__ */ jsx20(Glyph, { ...props, path: "m7 10 5 5 5-5" });
var IconCrossSmall = (props) => /* @__PURE__ */ jsx20(Glyph, { ...props, path: "m6 6 12 12 M18 6 6 18" });
var IconEditBig = (props) => /* @__PURE__ */ jsx20(Glyph, { ...props, path: "m14 5 5 5 M5 19l4-1L20 7l-4-4L5 14Z" });
var IconHome = (props) => /* @__PURE__ */ jsx20(Glyph, { ...props, path: "m3 10 9-7 9 7 M5 9v11h14V9 M10 20v-7h4v7" });
var IconMagnifyingGlass = (props) => /* @__PURE__ */ jsx20(Glyph, { ...props, path: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l6 6" });
var IconPlusMedium = (props) => /* @__PURE__ */ jsx20(Glyph, { ...props, path: "M12 5v14 M5 12h14" });
var IconSettingsGear1 = (props) => /* @__PURE__ */ jsx20(Glyph, { ...props, path: "M5 6h14 M5 12h14 M5 18h14 M9 3v6 M15 9v6 M9 15v6" });
var IconSidebarLeftArrow = (props) => /* @__PURE__ */ jsx20(Glyph, { ...props, path: "M3 4h18v16H3Z M9 4v16 m8-12-4 4 4 4" });
var IconUserAdd = (props) => /* @__PURE__ */ jsx20(Glyph, { ...props, path: "M12 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M3 20v-3a6 6 0 0 1 12 0v3 M19 7v8 M15 11h8" });
var WORKSPACE = { key: "nous", name: "Nous Research", monogram: "N" };
var NAV_ITEMS = [
  { key: "overview", label: "Overview", icon: /* @__PURE__ */ jsx20(IconHome, { size: 18 }), count: void 0 },
  { key: "inbox", label: "Inbox", icon: /* @__PURE__ */ jsx20("img", { src: INBOX_ASSET, width: "18", height: "18", alt: "" }), count: "4" },
  { key: "members", label: "Members", icon: /* @__PURE__ */ jsx20(IconUserAdd, { size: 18 }), count: void 0 },
  { key: "skills", label: "Shared skills", icon: /* @__PURE__ */ jsx20("img", { src: SKILL_ASSET, width: "18", height: "18", alt: "" }), count: void 0 }
];
var DEFAULT_RECENTS = [
  { id: "screening", label: "Screen partner applications" },
  { id: "prospects", label: "Find new partners" },
  { id: "readiness", label: "Check partner readiness" },
  { id: "guide", label: "Update onboarding guide" },
  { id: "feedback", label: "Summarize partner feedback" }
];
var SIDEBAR_MOTION = {
  expandedWidth: 224,
  collapsedWidth: 52,
  duration: 280,
  copyDuration: 180,
  copyOffset: 8,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)"
};
var CHAT_SEARCH_MOTION = {
  duration: 180,
  closedWidth: 28,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)"
};
function GlideGroup({ children }) {
  return /* @__PURE__ */ jsx20(
    GlideMenu,
    {
      rowSelector: "[data-row]",
      highlightClassName: "sidebar-glide-highlight rounded-[7px] bg-hover-2",
      className: "group/glide flex flex-col gap-px",
      children
    }
  );
}
function RailButton({
  icon,
  label,
  active = false,
  count,
  onClick
}) {
  return /* @__PURE__ */ jsxs17(
    "button",
    {
      "data-row": true,
      type: "button",
      "aria-label": label,
      title: label,
      onClick,
      className: `sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left
        transition-[width,background-color,color,transform] duration-150 active:scale-[0.98]
        ${active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""}`,
      children: [
        /* @__PURE__ */ jsx20("span", { className: `flex size-5 shrink-0 items-center justify-center ${active ? "text-ink" : "text-ink-2"}`, children: icon }),
        /* @__PURE__ */ jsx20("span", { className: `sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium ${active ? "text-ink" : "text-ink-2"}`, children: label }),
        count && /* @__PURE__ */ jsx20("span", { className: "sidebar-copy mr-2 shrink-0 text-[12px] font-medium tabular-nums text-ink-3", children: count })
      ]
    }
  );
}
function WorkspaceMenu({
  position,
  onClose,
  workspace,
  onAction
}) {
  const reduce = useReducedMotion();
  const menuRef = useRef12(null);
  useEffect14(() => {
    menuRef.current?.querySelector("button")?.focus();
  }, []);
  return createPortal4(
    /* @__PURE__ */ jsx20(
      "div",
      {
        "data-workspace-menu": true,
        ref: menuRef,
        "data-reduced-motion": reduce,
        className: "hermes-ui fixed z-50 w-64 rounded-[14px] bg-surface p-1.5 shadow-overlay",
        style: {
          top: position.top,
          left: position.left,
          animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both",
          transformOrigin: "top left"
        },
        children: /* @__PURE__ */ jsxs17(GlideMenu, { className: "flex flex-col gap-px", highlightClassName: "inset-x-0 rounded-[8px] bg-hover-2", children: [
          /* @__PURE__ */ jsxs17(
            "button",
            {
              "data-menu-row": true,
              type: "button",
              onClick: onClose,
              className: "relative z-10 flex h-10 w-full items-center gap-1.5 rounded-[8px] px-2 text-left",
              children: [
                /* @__PURE__ */ jsx20("span", { className: "flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-ink text-[11px] font-semibold text-surface", children: workspace.monogram }),
                /* @__PURE__ */ jsx20("span", { className: "min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink", children: workspace.name }),
                /* @__PURE__ */ jsx20("span", { className: "shrink-0 text-ink", children: /* @__PURE__ */ jsx20(IconCheckmark1Small, { size: 18 }) })
              ]
            }
          ),
          /* @__PURE__ */ jsx20("div", { className: "my-1 h-px bg-line" }),
          [
            { label: "Switch workspace", icon: /* @__PURE__ */ jsx20(IconPlusMedium, { size: 16 }) },
            { label: "Workspace settings", icon: /* @__PURE__ */ jsx20(IconSettingsGear1, { size: 16 }) },
            { label: "Invite team members", icon: /* @__PURE__ */ jsx20(IconUserAdd, { size: 16 }) }
          ].map((item) => /* @__PURE__ */ jsxs17(
            "button",
            {
              "data-menu-row": true,
              type: "button",
              onClick: () => {
                onAction?.(item.label);
                onClose();
              },
              className: "relative z-10 flex h-9 w-full items-center gap-1.5 rounded-[8px] px-2 text-left",
              children: [
                /* @__PURE__ */ jsx20("span", { className: "flex size-5 shrink-0 items-center justify-center text-ink-2", children: item.icon }),
                /* @__PURE__ */ jsx20("span", { className: "min-w-0 flex-1 truncate text-[13.5px] text-ink", children: item.label })
              ]
            },
            item.label
          ))
        ] })
      }
    ),
    document.body
  );
}
function SidebarNav({
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
  onWorkspaceAction
} = {}) {
  const reduce = useReducedMotion();
  const [collapsed, setCollapsed] = useState17(false);
  const [internalNav, setInternalNav] = useState17("chats");
  const currentNav = activeNav ?? internalNav;
  const selectNav = (key) => {
    setInternalNav(key);
    onNavigate?.(key);
  };
  const [demoActiveTitle, setDemoActiveTitle] = useState17(null);
  const [workspaceOpen, setWorkspaceOpen] = useState17(false);
  const [workspacePosition, setWorkspacePosition] = useState17({ top: 0, left: 0 });
  const [searchOpen, setSearchOpen] = useState17(false);
  const [query, setQuery] = useState17("");
  const workspaceButtonRef = useRef12(null);
  const searchRef = useRef12(null);
  const selectedTitle = activeTitle === void 0 ? demoActiveTitle : activeTitle;
  const visibleRecents = recents.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect14(() => {
    if (!workspaceOpen) return;
    const close = (event) => {
      const target = event.target;
      if (!target.closest("[data-workspace-trigger]") && !target.closest("[data-workspace-menu]")) {
        setWorkspaceOpen(false);
      }
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setWorkspaceOpen(false);
        workspaceButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [workspaceOpen]);
  useEffect14(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  const collapse = () => {
    setCollapsed(true);
    setWorkspaceOpen(false);
    setSearchOpen(false);
    setQuery("");
  };
  return /* @__PURE__ */ jsx20(
    "aside",
    {
      "data-sidebar-collapsed": collapsed,
      "aria-label": "Workspace navigation",
      className: `relative flex shrink-0 overflow-hidden transition-[width] ${fill ? "h-full" : "h-[600px]"} ${className}`,
      style: {
        width: collapsed ? SIDEBAR_MOTION.collapsedWidth : SIDEBAR_MOTION.expandedWidth,
        transitionDuration: reduce ? "0ms" : `${SIDEBAR_MOTION.duration}ms`,
        transitionTimingFunction: SIDEBAR_MOTION.easing,
        "--sidebar-copy-duration": reduce ? "0ms" : `${SIDEBAR_MOTION.copyDuration}ms`,
        "--sidebar-copy-offset": `${SIDEBAR_MOTION.copyOffset}px`,
        "--sidebar-easing": SIDEBAR_MOTION.easing
      },
      children: /* @__PURE__ */ jsxs17("div", { className: "flex min-h-0 w-[224px] shrink-0 flex-col", children: [
        /* @__PURE__ */ jsxs17("div", { className: "relative mb-2.5 h-10 shrink-0", children: [
          /* @__PURE__ */ jsxs17(
            "button",
            {
              ref: workspaceButtonRef,
              "data-workspace-trigger": true,
              type: "button",
              "aria-expanded": workspaceOpen,
              "aria-hidden": collapsed,
              tabIndex: collapsed ? -1 : 0,
              onClick: () => {
                if (!workspaceOpen && workspaceButtonRef.current) {
                  const rect = workspaceButtonRef.current.getBoundingClientRect();
                  setWorkspacePosition({ top: Math.min(rect.bottom + 6, window.innerHeight - 220), left: Math.max(8, Math.min(rect.left, window.innerWidth - 264)) });
                }
                setWorkspaceOpen((open) => !open);
              },
              className: "sidebar-workspace-control absolute left-2 top-1 flex h-8 w-[164px] items-center rounded-[8px] px-2 text-left transition-[background-color,transform] duration-100 hover:bg-hover-2 active:scale-[0.99]",
              children: [
                /* @__PURE__ */ jsx20("span", { className: "sidebar-logo flex size-5 shrink-0 items-center justify-center text-ink", children: /* @__PURE__ */ jsx20("img", { src: IRIS_ASSET, width: "20", height: "20", alt: "" }) }),
                /* @__PURE__ */ jsx20("span", { className: "sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink-2", children: workspace.name }),
                /* @__PURE__ */ jsx20("span", { className: "sidebar-copy ml-1 flex shrink-0 text-ink-3", children: /* @__PURE__ */ jsx20(IconChevronDownSmall, { size: 16 }) })
              ]
            }
          ),
          workspaceOpen && /* @__PURE__ */ jsx20(WorkspaceMenu, { position: workspacePosition, workspace, onAction: onWorkspaceAction, onClose: () => {
            setWorkspaceOpen(false);
            workspaceButtonRef.current?.focus();
          } }),
          /* @__PURE__ */ jsx20(
            "button",
            {
              type: "button",
              "aria-label": "Collapse sidebar",
              "aria-hidden": collapsed,
              tabIndex: collapsed ? -1 : 0,
              onClick: collapse,
              className: "sidebar-collapse-control absolute right-2 top-1 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink",
              children: /* @__PURE__ */ jsx20(IconSidebarLeftArrow, { size: 18 })
            }
          ),
          /* @__PURE__ */ jsx20(
            "button",
            {
              type: "button",
              "aria-label": "Expand sidebar",
              "aria-hidden": !collapsed,
              tabIndex: collapsed ? 0 : -1,
              onClick: () => setCollapsed(false),
              className: "sidebar-expand-control absolute left-2 top-0.5 flex size-9 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink",
              children: /* @__PURE__ */ jsx20(IconSidebarLeftArrow, { size: 18, className: "rotate-180" })
            }
          )
        ] }),
        /* @__PURE__ */ jsxs17(GlideGroup, { children: [
          /* @__PURE__ */ jsx20(
            RailButton,
            {
              icon: /* @__PURE__ */ jsx20(IconEditBig, { size: 18 }),
              label: "New session",
              onClick: () => {
                if (activeTitle === void 0) setDemoActiveTitle(null);
                selectNav("chats");
                onNewChat?.();
              }
            }
          ),
          navItems.map((item) => /* @__PURE__ */ jsx20(
            RailButton,
            {
              icon: item.icon,
              label: item.label,
              count: item.count,
              active: currentNav === item.key,
              onClick: () => selectNav(item.key)
            },
            item.key
          ))
        ] }),
        /* @__PURE__ */ jsxs17("div", { inert: collapsed, className: "mt-3 min-h-0 flex-1 overflow-y-auto", children: [
          /* @__PURE__ */ jsxs17("div", { className: "sidebar-copy relative mx-2 mb-1 h-8", children: [
            /* @__PURE__ */ jsxs17(
              "div",
              {
                "aria-hidden": searchOpen,
                className: `absolute inset-0 flex items-center gap-1.5 px-2 text-[12.5px] font-medium text-ink-3 transition-[opacity,transform] ${searchOpen ? "pointer-events-none -translate-x-1 opacity-0" : "translate-x-0 opacity-100"}`,
                style: { transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`, transitionTimingFunction: CHAT_SEARCH_MOTION.easing },
                children: [
                  /* @__PURE__ */ jsx20(IconChevronDownSmall, { size: 16 }),
                  /* @__PURE__ */ jsx20("span", { children: "Iris sessions" })
                ]
              }
            ),
            /* @__PURE__ */ jsx20(
              "button",
              {
                type: "button",
                "aria-label": "Search sessions",
                "aria-expanded": searchOpen,
                tabIndex: searchOpen ? -1 : 0,
                onClick: () => setSearchOpen(true),
                className: `absolute right-0 top-0 z-10 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color,transform] hover:bg-hover-2 hover:text-ink active:scale-[0.96] ${searchOpen ? "pointer-events-none opacity-0" : "opacity-100"}`,
                style: { transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms` },
                children: /* @__PURE__ */ jsx20(IconMagnifyingGlass, { size: 16 })
              }
            ),
            /* @__PURE__ */ jsxs17(
              "div",
              {
                className: `absolute right-0 top-0 z-20 flex h-8 items-center overflow-hidden rounded-[8px] bg-field text-ink-3 shadow-hairline transition-[width,opacity] focus-within:text-ink-2 ${searchOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`,
                style: {
                  width: searchOpen ? "100%" : CHAT_SEARCH_MOTION.closedWidth,
                  transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`,
                  transitionTimingFunction: CHAT_SEARCH_MOTION.easing
                },
                children: [
                  /* @__PURE__ */ jsx20("span", { className: "ml-2 flex shrink-0 items-center justify-center", children: /* @__PURE__ */ jsx20(IconMagnifyingGlass, { size: 15 }) }),
                  /* @__PURE__ */ jsx20(
                    "input",
                    {
                      ref: searchRef,
                      tabIndex: searchOpen ? 0 : -1,
                      value: query,
                      onChange: (event) => setQuery(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === "Escape") {
                          setSearchOpen(false);
                          setQuery("");
                        }
                      },
                      placeholder: "Search sessions",
                      "aria-label": "Search session history",
                      className: "ml-1.5 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-3"
                    }
                  ),
                  /* @__PURE__ */ jsx20(
                    "button",
                    {
                      type: "button",
                      "aria-label": "Close session search",
                      tabIndex: searchOpen ? 0 : -1,
                      onClick: () => {
                        setSearchOpen(false);
                        setQuery("");
                      },
                      className: "flex size-8 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]",
                      children: /* @__PURE__ */ jsx20(IconCrossSmall, { size: 16 })
                    }
                  )
                ]
              }
            )
          ] }),
          /* @__PURE__ */ jsxs17(GlideGroup, { children: [
            visibleRecents.map((item) => {
              const active = item.label === selectedTitle;
              return /* @__PURE__ */ jsx20(
                "button",
                {
                  "data-row": true,
                  type: "button",
                  title: item.label,
                  onClick: () => {
                    selectNav("chats");
                    if (activeTitle === void 0) setDemoActiveTitle(item.label);
                    onPick?.(item.id, item.label, item.prompt);
                  },
                  className: `sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""}`,
                  children: /* @__PURE__ */ jsx20("span", { className: `sidebar-copy min-w-0 flex-1 truncate text-[14px] font-medium ${active ? "text-ink" : "text-ink-2"}`, children: item.label })
                },
                item.id
              );
            }),
            query && visibleRecents.length === 0 && /* @__PURE__ */ jsx20("div", { className: "sidebar-copy mx-2 px-2 py-2 text-[12.5px] text-ink-3", children: "No sessions found" })
          ] })
        ] }),
        /* @__PURE__ */ jsx20("div", { inert: collapsed, className: "sidebar-copy mx-2 mt-3 w-[208px] border-t border-line pt-3", children: /* @__PURE__ */ jsxs17(
          "button",
          {
            type: "button",
            onClick: onFooterClick ?? (() => selectNav("settings")),
            className: "flex h-8 w-full items-center justify-center gap-1.5 rounded-control bg-hover-2 text-[12.5px] font-medium text-ink transition-[background-color,transform] duration-150 hover:bg-line-strong active:scale-[0.98]",
            children: [
              footerIcon,
              footerLabel
            ]
          }
        ) })
      ] })
    }
  );
}

// src/components/primitives/SearchList.tsx
import { useRef as useRef13, useState as useState18 } from "react";
import { jsx as jsx21, jsxs as jsxs18 } from "react/jsx-runtime";
var ITEMS = [
  "Screen partner applications",
  "Find potential partners",
  "Review the services agreement",
  "Check invoice evidence",
  "Find shared screening skills",
  "Summarize partner feedback",
  "Check permission settings"
];
var LABELS2 = {
  placeholder: "Search Iris\u2026",
  ariaLabel: "Search Iris",
  emptyTitle: "No results found",
  emptyHint: "Adjust your search to try again"
};
function SearchList({
  items = ITEMS,
  labels = LABELS2,
  onSelect
} = {}) {
  const rowRefs = useRef13([]);
  const inputRef = useRef13(null);
  const [query, setQuery] = useState18("");
  const results = query ? items.filter((i) => i.toLowerCase().includes(query.toLowerCase())) : items.slice(0, 5);
  const empty = results.length === 0;
  return /* @__PURE__ */ jsx21("div", { className: "flex min-h-[248px] w-full max-w-72 flex-col items-stretch", children: /* @__PURE__ */ jsxs18("div", { className: "w-full self-start overflow-hidden rounded-card bg-surface shadow-raised", children: [
    /* @__PURE__ */ jsxs18("div", { className: "flex h-10 items-center gap-2 border-b border-line px-3 transition-colors duration-100 hover:bg-hover", children: [
      /* @__PURE__ */ jsxs18("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "var(--ink-3)", strokeWidth: "2", strokeLinecap: "round", className: "shrink-0", children: [
        /* @__PURE__ */ jsx21("circle", { cx: "11", cy: "11", r: "7" }),
        /* @__PURE__ */ jsx21("path", { d: "M21 21l-4.3-4.3" })
      ] }),
      /* @__PURE__ */ jsx21(
        "input",
        {
          ref: inputRef,
          onKeyDown: (event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              rowRefs.current[0]?.focus();
            }
            if (event.key === "Enter" && results[0]) {
              setQuery(results[0]);
              onSelect?.(results[0]);
            }
            if (event.key === "Escape") setQuery("");
          },
          value: query,
          onChange: (event) => setQuery(event.target.value),
          placeholder: labels.placeholder,
          "aria-label": labels.ariaLabel,
          className: "min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
        }
      ),
      query && /* @__PURE__ */ jsx21(
        "button",
        {
          "aria-label": "Clear search",
          type: "button",
          onClick: () => {
            setQuery("");
            inputRef.current?.focus();
          },
          className: "flex size-6 items-center justify-center rounded-full text-ink-3\n                transition-colors duration-100 hover:bg-line/70 hover:text-ink",
          style: { animation: "fade-in 150ms ease-out both" },
          children: /* @__PURE__ */ jsx21("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", children: /* @__PURE__ */ jsx21("path", { d: "M18 6L6 18M6 6l12 12" }) })
        }
      )
    ] }),
    empty ? /* @__PURE__ */ jsxs18("div", { className: "flex flex-col items-center justify-center gap-1 px-4 py-8", style: { animation: "fade-in 250ms ease-out both" }, children: [
      /* @__PURE__ */ jsx21("span", { className: "mb-1.5 flex size-8 items-center justify-center rounded-control bg-inset text-ink-3 shadow-hairline", children: /* @__PURE__ */ jsxs18("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", children: [
        /* @__PURE__ */ jsx21("circle", { cx: "11", cy: "11", r: "7" }),
        /* @__PURE__ */ jsx21("path", { d: "M21 21l-4.3-4.3" })
      ] }) }),
      /* @__PURE__ */ jsx21("span", { className: "text-[13px] font-medium text-ink", children: labels.emptyTitle }),
      /* @__PURE__ */ jsx21("span", { className: "text-[12px] text-ink-3", children: labels.emptyHint })
    ] }) : /* @__PURE__ */ jsx21("div", { className: "p-1", children: /* @__PURE__ */ jsx21(GlideMenu, { className: "flex flex-col gap-px", highlightClassName: "inset-x-0 rounded-[6px] bg-hover", children: results.map((item, index) => /* @__PURE__ */ jsx21(
      "button",
      {
        ref: (element) => {
          rowRefs.current[index] = element;
        },
        onKeyDown: (event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            rowRefs.current[(index + 1) % results.length]?.focus();
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            if (index === 0) inputRef.current?.focus();
            else rowRefs.current[index - 1]?.focus();
          }
          if (event.key === "Escape") inputRef.current?.focus();
        },
        "data-menu-row": true,
        type: "button",
        onClick: () => {
          setQuery(item);
          onSelect?.(item);
        },
        className: "relative z-10 flex h-8 w-full items-center rounded-[6px] px-2 text-left text-[13px] text-ink",
        style: { animation: "fade-in 200ms ease-out both" },
        children: item
      },
      item
    )) }) })
  ] }) });
}

// src/components/primitives/Flowchart.tsx
import { useEffect as useEffect15, useRef as useRef14, useState as useState19 } from "react";
import { useLayoutEffect as useLayoutEffect5 } from "react";
import { jsx as jsx22, jsxs as jsxs19 } from "react/jsx-runtime";
var PURPLE = "var(--accent)";
var AMBER = "var(--orange)";
var mix = (hue, pct, base = "var(--surface)") => `color-mix(in srgb, ${hue} ${pct}%, ${base})`;
var PAD_Y = 24;
var ROW_GAP = 64;
var PILL_OFFSET = 30;
var PARTNER_STEPS = [
  { id: "trigger", row: 0, x: 0.5, w: 300, kind: { label: "Every application", hue: PURPLE }, hue: PURPLE, title: "New partner application", caption: "Wait for each new application" },
  { id: "screen", row: 1, x: 0.5, w: 300, kind: { label: "Iris", hue: PURPLE }, hue: PURPLE, title: "Screen against criteria", caption: "Cite sources. Surface missing evidence." },
  { id: "review", row: 2, x: 0.5, w: 356, kind: { label: "Human review", hue: AMBER }, condition: true }
];
var EDGES = [{ from: "trigger", to: "screen" }, { from: "screen", to: "review" }, { from: "review", to: "trigger", loop: true }];
var EST_H = { trigger: 92, screen: 92, review: 134 };
var PROPERTIES = ["status", "reviewer", "role", "evidence"];
var STATUSES = [{ name: "Needs review" }, { name: "Context missing" }, { name: "Reviewed" }];
var REVIEWERS = [{ name: "Maya Chen" }, { name: "Dana Park" }];
function PartnerIcon({ size = 16 }) {
  return /* @__PURE__ */ jsxs19("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: [
    /* @__PURE__ */ jsx22("rect", { x: "4", y: "5", width: "16", height: "15", rx: "3" }),
    /* @__PURE__ */ jsx22("path", { d: "M8 3v4M16 3v4M8 11h8M8 15h5" })
  ] });
}
function Chevron() {
  return /* @__PURE__ */ jsx22("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.4", strokeLinecap: "round", strokeLinejoin: "round", className: "shrink-0 text-ink-3", children: /* @__PURE__ */ jsx22("path", { d: "m6 9 6 6 6-6" }) });
}
function Handle() {
  return /* @__PURE__ */ jsx22("svg", { width: "10", height: "16", viewBox: "0 0 10 16", className: "shrink-0 cursor-grab text-ink-3/70", children: [3, 8, 13].flatMap((y) => [
    /* @__PURE__ */ jsx22("circle", { cx: "3", cy: y, r: "1.1", fill: "currentColor" }, `l${y}`),
    /* @__PURE__ */ jsx22("circle", { cx: "7.5", cy: y, r: "1.1", fill: "currentColor" }, `r${y}`)
  ]) });
}
function CheckIcon2() {
  return /* @__PURE__ */ jsx22("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx22("path", { d: "M20 6L9 17l-5-5" }) });
}
function Menu({
  items,
  value,
  width,
  align,
  onPick
}) {
  const [hovered, setHovered] = useState19(null);
  const rowRefs = useRef14([]);
  const [box, setBox] = useState19(null);
  const valueIndex = items.findIndex((item) => item.name === value);
  useLayoutEffect5(() => {
    const row = rowRefs.current[hovered ?? valueIndex];
    if (row) setBox({ top: row.offsetTop, height: row.offsetHeight });
  }, [hovered, valueIndex]);
  return /* @__PURE__ */ jsxs19(
    "div",
    {
      onMouseLeave: () => setHovered(null),
      className: `absolute bottom-full z-20 mb-1.5 rounded-[10px] bg-surface p-1 shadow-raised ${width}
        ${align === "right" ? "right-0" : "left-0"}`,
      style: {
        animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both",
        transformOrigin: align === "right" ? "bottom right" : "bottom left"
      },
      children: [
        /* @__PURE__ */ jsx22(
          "span",
          {
            "aria-hidden": true,
            className: "pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover",
            style: {
              top: box?.top ?? 0,
              height: box?.height ?? 0,
              opacity: box && hovered !== null ? 1 : 0,
              transition: "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease"
            }
          }
        ),
        items.map((item, i) => /* @__PURE__ */ jsxs19(
          "button",
          {
            type: "button",
            ref: (el) => {
              rowRefs.current[i] = el;
            },
            onMouseEnter: () => setHovered(i),
            onClick: () => onPick(item.name),
            className: "relative z-10 flex h-7.5 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left",
            children: [
              /* @__PURE__ */ jsx22("span", { className: "min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink", children: item.name }),
              item.tag && /* @__PURE__ */ jsx22("span", { className: "shrink-0 text-[11px] text-ink-3", children: item.tag }),
              /* @__PURE__ */ jsx22("span", { className: `shrink-0 text-ink ${item.name === value ? "" : "invisible"}`, children: /* @__PURE__ */ jsx22(CheckIcon2, {}) })
            ]
          },
          item.name
        ))
      ]
    }
  );
}
function SourceChip2() {
  return /* @__PURE__ */ jsxs19(
    "span",
    {
      "data-ui": true,
      className: "inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] bg-surface px-1.5 text-[12px] font-medium text-ink shadow-btn",
      children: [
        /* @__PURE__ */ jsx22("span", { className: "text-ink-2", children: /* @__PURE__ */ jsx22(PartnerIcon, { size: 12 }) }),
        "application"
      ]
    }
  );
}
function SelectChip({
  id,
  value,
  dot,
  items,
  width,
  align = "left",
  open,
  onToggle,
  onPick
}) {
  return /* @__PURE__ */ jsxs19("span", { "data-ui": true, className: "relative inline-flex min-w-0", children: [
    /* @__PURE__ */ jsxs19(
      "button",
      {
        type: "button",
        "aria-expanded": open,
        onClick: () => onToggle(id),
        className: `inline-flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-[6px] px-1.5
          text-[12px] font-medium text-ink transition-colors duration-100
          ${open ? "bg-hover-2" : "bg-field hover:bg-hover-2"}`,
        children: [
          dot && /* @__PURE__ */ jsx22("span", { className: "size-1.5 shrink-0 rounded-full", style: { background: AMBER } }),
          /* @__PURE__ */ jsx22("span", { className: "min-w-0 truncate", children: value }),
          /* @__PURE__ */ jsx22(Chevron, {})
        ]
      }
    ),
    open && /* @__PURE__ */ jsx22(
      Menu,
      {
        items,
        value,
        width,
        align,
        onPick: (name) => onPick(id, name)
      }
    )
  ] });
}
function ConditionBody({ onChange }) {
  const [values, setValues] = useState19({
    prop1: "status",
    val1: "Needs review",
    prop2: "reviewer",
    val2: "Maya Chen"
  });
  const [open, setOpen] = useState19(null);
  useEffect15(() => {
    if (!open) return;
    const close = (event) => {
      if (!event.target.closest("[data-ui]")) setOpen(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const toggle = (id) => setOpen((current) => current === id ? null : id);
  const pick = (id, name) => {
    const next = { ...values, [id]: name };
    setValues(next);
    onChange?.(next);
    setOpen(null);
  };
  const chip = (id, items, width, extra) => /* @__PURE__ */ jsx22(
    SelectChip,
    {
      id,
      value: values[id],
      items,
      width,
      open: open === id,
      onToggle: toggle,
      onPick: pick,
      ...extra
    }
  );
  return /* @__PURE__ */ jsxs19("div", { className: "flex flex-col gap-1.5 px-3 py-2.5", children: [
    /* @__PURE__ */ jsxs19("div", { className: "flex min-w-0 items-center gap-1.5", children: [
      /* @__PURE__ */ jsx22(Handle, {}),
      /* @__PURE__ */ jsx22("span", { className: "w-7 text-[12.5px] text-ink-2", children: "If" }),
      /* @__PURE__ */ jsx22(SourceChip2, {}),
      chip("prop1", PROPERTIES.map((name) => ({ name })), "w-36"),
      /* @__PURE__ */ jsx22("span", { className: "text-[12.5px] text-ink-2", children: "is" }),
      chip("val1", STATUSES, "w-44", { dot: true, align: "right" })
    ] }),
    /* @__PURE__ */ jsxs19("div", { className: "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1.5", children: [
      /* @__PURE__ */ jsx22(Handle, {}),
      /* @__PURE__ */ jsx22("span", { className: "w-7 text-[12.5px] text-ink-2", children: "and" }),
      /* @__PURE__ */ jsx22(SourceChip2, {}),
      chip("prop2", PROPERTIES.map((name) => ({ name })), "w-36"),
      /* @__PURE__ */ jsx22("span", { className: "text-[12.5px] text-ink-2", children: "is" }),
      /* @__PURE__ */ jsx22("span", { className: "max-w-full pl-[49px]", children: chip("val2", REVIEWERS, "w-64", { dot: true }) })
    ] })
  ] });
}
function StepBody({ node }) {
  return /* @__PURE__ */ jsxs19("div", { className: "flex items-center gap-2.5 p-2.5", children: [
    /* @__PURE__ */ jsx22(
      "span",
      {
        className: "flex size-9 shrink-0 items-center justify-center rounded-[8px]",
        style: {
          background: mix(node.hue, 12),
          color: node.hue,
          boxShadow: `0 0 0 1px ${mix(node.hue, 20)}`
        },
        children: /* @__PURE__ */ jsx22(PartnerIcon, {})
      }
    ),
    /* @__PURE__ */ jsxs19("span", { className: "min-w-0 text-left", children: [
      /* @__PURE__ */ jsx22("span", { className: "block truncate text-[13px] font-semibold leading-tight text-ink", children: node.title }),
      /* @__PURE__ */ jsx22("span", { className: "mt-0.5 block text-[12px] leading-snug text-ink-2", children: node.caption })
    ] })
  ] });
}
function Flowchart({ steps = PARTNER_STEPS, edges = EDGES, onSelect, onMove, onConditionsChange } = {}) {
  const reduce = useReducedMotion();
  const canvasRef = useRef14(null);
  const nodeRefs = useRef14(/* @__PURE__ */ new Map());
  const [width, setWidth] = useState19(0);
  const [heights, setHeights] = useState19(EST_H);
  const [selected, setSelected] = useState19(null);
  const [offsets, setOffsets] = useState19({});
  const drag = useRef14(null);
  useLayoutEffect5(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      setWidth(canvas.clientWidth);
      setHeights((prev) => {
        const next = { ...prev };
        let changed = false;
        nodeRefs.current.forEach((el, id) => {
          const h = el.offsetHeight;
          if (h && Math.abs(h - (next[id] ?? 0)) > 0.5) {
            next[id] = h;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    nodeRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  const rows = [...new Set(steps.map((n) => n.row))].sort((a, b) => a - b);
  if (!steps.length) return null;
  const rowH = rows.map(
    (r) => Math.max(...steps.filter((n) => n.row === r).map((n) => heights[n.id] ?? 90))
  );
  const rowY = [];
  rows.forEach((_, i) => {
    rowY[i] = i === 0 ? PAD_Y : rowY[i - 1] + rowH[i - 1] + ROW_GAP;
  });
  const canvasH = rowY[rows.length - 1] + rowH[rows.length - 1] + PAD_Y;
  const cw = width || 480;
  const place = (n) => {
    const w = Math.min(n.w, cw * 0.92);
    const off = offsets[n.id];
    return {
      w,
      cx: n.x * cw + (off?.dx ?? 0),
      top: rowY[rows.indexOf(n.row)] + (off?.dy ?? 0)
    };
  };
  const anchors = (n) => {
    const { cx, top } = place(n);
    return {
      top: { x: cx, y: top + (n.kind ? PILL_OFFSET : 0) },
      bottom: { x: cx, y: top + (heights[n.id] ?? 90) }
    };
  };
  const bezier = (edge) => {
    const from = anchors(steps.find((n) => n.id === edge.from)).bottom;
    const to = anchors(steps.find((n) => n.id === edge.to)).top;
    if (edge.loop) {
      const side = Math.max(12, cw * 0.06);
      return `M ${from.x} ${from.y} C ${from.x} ${from.y + 30}, ${side} ${from.y + 30}, ${side} ${from.y} L ${side} ${to.y - 12} Q ${side} ${to.y - 30}, ${to.x} ${to.y}`;
    }
    const k = Math.min(Math.max(Math.abs(to.y - from.y) * 0.55, 24), 84);
    return `M ${from.x} ${from.y} C ${from.x} ${from.y + k}, ${to.x} ${to.y - k}, ${to.x} ${to.y}`;
  };
  const onPointerDown = (node) => (event) => {
    if (event.target.closest("[data-ui]")) return;
    const off = offsets[node.id];
    drag.current = {
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      baseDx: off?.dx ?? 0,
      baseDy: off?.dy ?? 0,
      moved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (node) => (event) => {
    const d = drag.current;
    if (!d || d.id !== node.id) return;
    const dx = d.baseDx + event.clientX - d.startX;
    const dy = d.baseDy + event.clientY - d.startY;
    if (!d.moved && Math.hypot(dx - d.baseDx, dy - d.baseDy) < 3) return;
    d.moved = true;
    const { w } = place(node);
    const h = heights[node.id] ?? 90;
    const baseCx = node.x * cw;
    const baseTop = rowY[rows.indexOf(node.row)];
    const cx = Math.min(Math.max(baseCx + dx, w / 2 + 8), cw - w / 2 - 8);
    const top = Math.min(Math.max(baseTop + dy, 8), canvasH - h - 8);
    setOffsets((current) => ({ ...current, [node.id]: { dx: cx - baseCx, dy: top - baseTop } }));
  };
  const onPointerUp = (node) => () => {
    const d = drag.current;
    if (d?.id === node.id) {
      if (d.moved) {
        onMove?.(node.id, offsets[node.id]);
        setTimeout(() => drag.current = null, 0);
      } else drag.current = null;
    }
  };
  const wasDragged = () => drag.current?.moved === true;
  const isLit = (edge) => selected === edge.from || selected === edge.to;
  return /* @__PURE__ */ jsxs19(
    "div",
    {
      ref: canvasRef,
      "data-reduced-motion": reduce,
      className: "hermes-ui relative w-full select-none overflow-hidden rounded-card bg-page shadow-hairline",
      style: {
        height: canvasH,
        backgroundImage: "radial-gradient(var(--line-strong) 1px, transparent 1.25px)",
        backgroundSize: "22px 22px",
        backgroundPosition: "center"
      },
      children: [
        /* @__PURE__ */ jsx22("svg", { width: cw, height: canvasH, className: "pointer-events-none absolute inset-0", children: edges.filter((edge) => steps.some((n) => n.id === edge.from) && steps.some((n) => n.id === edge.to)).map((edge) => /* @__PURE__ */ jsx22(
          "path",
          {
            d: bezier(edge),
            fill: "none",
            stroke: isLit(edge) ? "var(--accent)" : "var(--line-strong)",
            strokeWidth: "1.25",
            strokeDasharray: edge.loop ? "4 4" : void 0,
            className: "transition-[stroke] duration-150"
          },
          `${edge.from}-${edge.to}`
        )) }),
        steps.map((node) => {
          const { w, cx, top } = place(node);
          const active = selected === node.id;
          return /* @__PURE__ */ jsxs19(
            "div",
            {
              ref: (el) => {
                if (el) nodeRefs.current.set(node.id, el);
                else nodeRefs.current.delete(node.id);
              },
              onPointerDown: onPointerDown(node),
              onPointerMove: onPointerMove(node),
              onPointerUp: onPointerUp(node),
              className: "absolute flex -translate-x-1/2 touch-none flex-col items-start gap-1.5",
              style: { left: cx, top, width: w, zIndex: drag.current?.id === node.id ? 2 : 1 },
              children: [
                node.kind && /* @__PURE__ */ jsx22(
                  "span",
                  {
                    className: "inline-flex h-6 items-center rounded-[6px] px-2 text-[11.5px] font-medium",
                    style: {
                      background: mix(node.kind.hue, 14, "var(--page)"),
                      color: mix(node.kind.hue, 80, "var(--ink)")
                    },
                    children: node.kind.label
                  }
                ),
                node.condition ? /* @__PURE__ */ jsx22("div", { className: "w-full rounded-[18px] bg-surface shadow-card transition-shadow duration-150 hover:shadow-raised", children: /* @__PURE__ */ jsx22(ConditionBody, { onChange: onConditionsChange }) }) : /* @__PURE__ */ jsx22(
                  "button",
                  {
                    type: "button",
                    onClick: () => {
                      if (wasDragged()) return;
                      setSelected(active ? null : node.id);
                      onSelect?.(active ? null : node);
                    },
                    "aria-pressed": active,
                    className: `w-full cursor-pointer rounded-[18px] bg-surface text-left outline-none
                  transition-shadow duration-150 focus-visible:shadow-[0_0_0_1.5px_var(--accent)]
                  ${active ? "shadow-[0_0_0_1.5px_var(--accent),0_2px_10px_rgba(0,0,0,0.045)]" : "shadow-card hover:shadow-raised"}`,
                    children: /* @__PURE__ */ jsx22(StepBody, { node })
                  }
                )
              ]
            },
            node.id
          );
        })
      ]
    }
  );
}

// src/components/primitives/InsightCards.tsx
import { Liveline } from "liveline";
import { useEffect as useEffect16, useMemo as useMemo2, useState as useState20 } from "react";
import { Fragment as Fragment7, jsx as jsx23, jsxs as jsxs20 } from "react/jsx-runtime";
var EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
var formatPercent = (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
function makePoints(values, gap = 6) {
  const end = Math.floor(Date.now() / 1e3);
  return values.map((value, index) => ({
    time: end - (values.length - 1 - index) * gap,
    value
  }));
}
function smooth(values, perSegment = 9) {
  if (values.length < 3) return values.slice();
  const out = [];
  const n = values.length;
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = values[Math.max(0, i - 1)];
    const p1 = values[i];
    const p2 = values[i + 1];
    const p3 = values[Math.min(n - 1, i + 2)];
    for (let s = 0; s < perSegment; s += 1) {
      const t = s / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
      );
    }
  }
  out.push(values[n - 1]);
  return out;
}
function smoothPoints(values, spanSecs) {
  const dense = smooth(values);
  return makePoints(dense, spanSecs / (dense.length - 1));
}
function useDarkMode() {
  const [dark, setDark] = useState20(false);
  useEffect16(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains("dark") || getComputedStyle(document.querySelector(".hermes-ui") ?? root).colorScheme.includes("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
function Entity({ name, tone }) {
  return /* @__PURE__ */ jsxs20("span", { className: "inline-flex items-center gap-1 align-baseline font-medium text-ink", children: [
    /* @__PURE__ */ jsx23("span", { className: `inline-block size-2.5 rounded-full ${tone}` }),
    "@",
    name
  ] });
}
function Mono({ children, tone }) {
  return /* @__PURE__ */ jsx23("code", { className: `font-mono text-[11.5px] ${tone === "red" ? "text-red" : "text-green"}`, children });
}
function chartIndexFromPointer(event, pointCount) {
  const rect = event.currentTarget.getBoundingClientRect();
  const progress = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return Math.round(progress * (pointCount - 1));
}
function ChartTooltip({ rows }) {
  return /* @__PURE__ */ jsx23("div", { className: "insight-chart-tooltip", children: rows.map((row) => /* @__PURE__ */ jsxs20("span", { className: "insight-chart-tooltip-item", children: [
    /* @__PURE__ */ jsx23("span", { className: "insight-chart-tooltip-dot", style: { background: row.color } }),
    row.label,
    ": ",
    row.value
  ] }, row.label)) });
}
var COMPARE_SERIES = [
  {
    name: "Applications",
    values: [-2.9, -3.4, -3.05, -3.86, -3.52, -4.1, -3.82, -4.41],
    sub: "Illustrative change",
    tone: "red",
    dot: "bg-orange",
    color: "#f68f3c",
    tooltipColor: "var(--orange)"
  },
  {
    name: "Prospects",
    values: [0.22, 0.58, 0.42, 0.91, 0.76, 1.08, 0.96, 1.15],
    sub: "Illustrative change",
    tone: "green",
    dot: "bg-accent",
    color: "#3d9aff",
    tooltipColor: "var(--accent)"
  }
];
function CompareCard({ series = COMPARE_SERIES }) {
  const dark = useDarkMode();
  const [hoverIndex, setHoverIndex] = useState20(null);
  const points = useMemo2(
    () => series.map((s) => smoothPoints(s.values, 42)),
    [series]
  );
  const pointCount = points[0]?.length ?? 0;
  const chartSeries = useMemo2(
    () => series.map((s, i) => ({
      id: s.name,
      label: "",
      data: points[i],
      value: points[i].at(-1)?.value ?? (s.values.at(-1) ?? 0),
      color: s.color
    })),
    [series, points]
  );
  return /* @__PURE__ */ jsxs20("div", { className: "min-h-[278px] rounded-card bg-surface p-3 shadow-hairline", children: [
    /* @__PURE__ */ jsx23("div", { className: "flex items-center gap-4", children: series.map((s, i) => /* @__PURE__ */ jsxs20("div", { className: "flex-1", children: [
      /* @__PURE__ */ jsxs20("span", { className: "flex items-center gap-1.5 text-[11.5px] text-ink-2", children: [
        /* @__PURE__ */ jsx23("span", { className: `size-2 rounded-full ${s.dot}` }),
        s.name
      ] }),
      /* @__PURE__ */ jsx23("span", { className: `block text-[17px] font-semibold tracking-[-0.01em] tabular-nums ${s.tone === "red" ? "text-red" : "text-green"}`, children: formatPercent(points[i].at(-1)?.value ?? (s.values.at(-1) ?? 0)) }),
      /* @__PURE__ */ jsx23(Mono, { tone: s.tone, children: s.sub })
    ] }, s.name)) }),
    /* @__PURE__ */ jsxs20("div", { className: "mt-2 overflow-hidden rounded-control bg-inset shadow-hairline", children: [
      /* @__PURE__ */ jsxs20("div", { className: "flex items-center justify-between border-b border-line px-2.5 py-1.5", children: [
        /* @__PURE__ */ jsx23("span", { className: "text-[11px] text-ink-3 tabular-nums", children: "Evidence coverage change" }),
        /* @__PURE__ */ jsx23("span", { className: "rounded-full bg-field px-2 py-0.5 text-[10.5px] font-medium text-ink-2", children: "Illustrative" })
      ] }),
      /* @__PURE__ */ jsxs20(
        "div",
        {
          className: "insight-chart-stage relative h-[166px]",
          onPointerDown: (event) => setHoverIndex(chartIndexFromPointer(event, pointCount)),
          onPointerMove: (event) => setHoverIndex(chartIndexFromPointer(event, pointCount)),
          onPointerLeave: () => setHoverIndex(null),
          onPointerCancel: () => setHoverIndex(null),
          onPointerUp: () => setHoverIndex(null),
          children: [
            /* @__PURE__ */ jsx23(
              Liveline,
              {
                data: [],
                value: 0,
                series: chartSeries,
                theme: dark ? "dark" : "light",
                grid: false,
                pulse: false,
                window: 42,
                paused: true,
                scrub: false,
                cursor: "default",
                lineWidth: 2.25,
                padding: { top: 40, right: 0, bottom: 22, left: 0 },
                formatValue: formatPercent
              }
            ),
            hoverIndex !== null && /* @__PURE__ */ jsxs20(Fragment7, { children: [
              /* @__PURE__ */ jsx23("span", { className: "insight-chart-cursor", style: { left: `${hoverIndex / (pointCount - 1) * 100}%` } }),
              /* @__PURE__ */ jsx23("span", { className: "insight-chart-tooltip-anchor", style: { left: `${Math.min(Math.max(hoverIndex / (pointCount - 1) * 100, 28), 72)}%` }, children: /* @__PURE__ */ jsx23(ChartTooltip, { rows: series.map((s, i) => ({ label: s.name, value: formatPercent(points[i][hoverIndex].value), color: s.tooltipColor })) }) })
            ] })
          ]
        }
      )
    ] })
  ] });
}
var ANOMALY_DATA = {
  spend: [2, 3, 2, 4, 3, 4, 6, 8],
  usage: [4, 5, 3, 6, 5, 8, 10, 12]
};
function AnomalyCard({ data: anomaly = ANOMALY_DATA }) {
  const dark = useDarkMode();
  const [metric, setMetric] = useState20("spend");
  const [hoverIndex, setHoverIndex] = useState20(null);
  const spend = useMemo2(
    () => makePoints(anomaly.spend, 7),
    [anomaly]
  );
  const usage = useMemo2(
    () => makePoints(anomaly.usage, 7),
    [anomaly]
  );
  const data = metric === "spend" ? spend : usage;
  const value = data.at(-1)?.value ?? (metric === "spend" ? 8 : 12);
  const threshold = metric === "spend" ? "6 reviews" : "10 hours";
  const moneyLabel = String(Math.round(spend.at(-1)?.value ?? 8));
  return /* @__PURE__ */ jsxs20("div", { className: "min-h-[278px] rounded-card bg-surface p-3 shadow-hairline", children: [
    /* @__PURE__ */ jsxs20("div", { className: "flex items-center justify-between", children: [
      /* @__PURE__ */ jsxs20("span", { className: "flex items-center gap-1.5 text-[12px] font-medium text-ink", children: [
        /* @__PURE__ */ jsx23("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "var(--red)", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx23("path", { d: "M12 19V5M5 12l7-7 7 7" }) }),
        "Review queue"
      ] }),
      /* @__PURE__ */ jsx23("span", { className: "rounded-full bg-field px-2 py-0.5 text-[10.5px] font-medium text-ink-2", children: "Illustrative" })
    ] }),
    /* @__PURE__ */ jsxs20("div", { className: "mt-2 overflow-hidden rounded-control bg-inset shadow-hairline", children: [
      /* @__PURE__ */ jsxs20("div", { className: "flex items-center justify-between border-b border-line px-2.5 py-1.5", children: [
        /* @__PURE__ */ jsx23("span", { className: "text-[11px] text-ink-3 tabular-nums", children: hoverIndex !== null ? metric === "spend" ? `${Math.round(data[hoverIndex].value)} reviews` : `${Math.round(data[hoverIndex].value)} hours` : `${threshold} threshold` }),
        /* @__PURE__ */ jsx23("span", { className: "flex rounded-full bg-field p-0.5", children: ["spend", "usage"].map((item) => /* @__PURE__ */ jsx23(
          "button",
          {
            type: "button",
            "aria-pressed": metric === item,
            onClick: () => setMetric(item),
            className: `rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.96] ${metric === item ? "bg-surface text-ink shadow-btn" : "text-ink-3 hover:text-ink-2"}`,
            children: item === "spend" ? "Reviews" : "Age"
          },
          item
        )) })
      ] }),
      /* @__PURE__ */ jsxs20(
        "div",
        {
          className: "insight-chart-stage relative h-[166px]",
          onPointerDown: (event) => setHoverIndex(chartIndexFromPointer(event, data.length)),
          onPointerMove: (event) => setHoverIndex(chartIndexFromPointer(event, data.length)),
          onPointerLeave: () => setHoverIndex(null),
          onPointerCancel: () => setHoverIndex(null),
          onPointerUp: () => setHoverIndex(null),
          children: [
            /* @__PURE__ */ jsx23(
              Liveline,
              {
                data,
                value,
                theme: dark ? "dark" : "light",
                color: "#ee5c61",
                grid: true,
                scrub: false,
                fill: false,
                pulse: false,
                momentum: false,
                paused: true,
                window: 49,
                lineWidth: 2.25,
                cursor: "crosshair",
                padding: { top: 34, right: 0, bottom: 22, left: 0 },
                formatValue: (v) => metric === "spend" ? `${Math.round(v)} reviews` : `${Math.round(v)} hours`
              }
            ),
            hoverIndex !== null && /* @__PURE__ */ jsxs20(Fragment7, { children: [
              /* @__PURE__ */ jsx23("span", { className: "insight-chart-cursor", style: { left: `${hoverIndex / (data.length - 1) * 100}%` } }),
              /* @__PURE__ */ jsx23("span", { className: "insight-chart-tooltip-anchor", style: { left: `${Math.min(Math.max(hoverIndex / (data.length - 1) * 100, 28), 72)}%` }, children: /* @__PURE__ */ jsx23(ChartTooltip, { rows: [{ label: metric === "spend" ? "Reviews" : "Age", value: metric === "spend" ? `${Math.round(data[hoverIndex].value)} reviews` : `${Math.round(data[hoverIndex].value)} hours`, color: "var(--red)" }] }) })
            ] })
          ]
        }
      )
    ] }),
    /* @__PURE__ */ jsxs20("div", { className: "mt-1.5 flex items-baseline gap-2", children: [
      /* @__PURE__ */ jsxs20("span", { className: "text-[17px] font-semibold tracking-[-0.01em] text-ink tabular-nums", children: [
        moneyLabel,
        " reviews waiting"
      ] }),
      /* @__PURE__ */ jsx23(Mono, { tone: "red", children: "+6 reviews" }),
      /* @__PURE__ */ jsx23("span", { className: "text-[11px] text-ink-3", children: "in this sample" })
    ] })
  ] });
}
var ALLOCATION_SEGMENTS = [
  { name: "TECH", label: "Technical partners", pct: 72.5, amount: "72.5%", cls: "bg-orange", tone: "text-orange" },
  { name: "COMM", label: "Community partners", pct: 22.8, amount: "22.8%", cls: "bg-line-strong", tone: "text-ink-2" },
  { name: "REF", label: "Referral partners", pct: 4.7, amount: "4.7%", cls: "bg-line", tone: "text-ink-3" }
];
function AllocationCard({ segments = ALLOCATION_SEGMENTS }) {
  const [selected, setSelected] = useState20(segments[0].name);
  const active = segments.find((segment) => segment.name === selected) ?? segments[0];
  return /* @__PURE__ */ jsxs20("div", { className: "min-h-[278px] rounded-card bg-surface p-3 shadow-hairline", children: [
    /* @__PURE__ */ jsxs20("span", { className: "flex items-center gap-1.5 text-[12px] font-medium text-ink", children: [
      /* @__PURE__ */ jsx23("span", { className: "flex size-3.5 items-center justify-center rounded-full bg-orange text-[8px] font-bold text-white", children: "P" }),
      "Partner mix"
    ] }),
    /* @__PURE__ */ jsx23("span", { className: "mt-1 block text-[20px] font-semibold tracking-[-0.01em] text-ink tabular-nums", children: active.amount }),
    /* @__PURE__ */ jsx23(
      "div",
      {
        className: "mt-3 flex h-9 gap-0.5 overflow-hidden rounded-full bg-field p-0.5",
        role: "group",
        "aria-label": "Allocation segments",
        children: segments.map((s) => /* @__PURE__ */ jsx23(
          "button",
          {
            type: "button",
            "aria-pressed": selected === s.name,
            "aria-label": `${s.label}: ${s.pct}%`,
            onClick: () => setSelected(s.name),
            className: `relative h-full overflow-hidden rounded-full ${s.cls} transition-[opacity,transform,box-shadow] duration-300 active:scale-[0.98]`,
            style: {
              width: `${s.pct}%`,
              opacity: selected === s.name ? 1 : 0.58,
              boxShadow: selected === s.name ? "inset 0 0 0 1px rgba(255,255,255,0.22)" : void 0,
              transitionTimingFunction: EASE
            },
            children: /* @__PURE__ */ jsx23(
              "span",
              {
                className: "absolute inset-y-1 left-1 rounded-full bg-white/20 transition-[width,opacity] duration-500",
                style: {
                  width: selected === s.name ? "calc(100% - 8px)" : "0%",
                  opacity: selected === s.name ? 1 : 0,
                  transitionTimingFunction: EASE
                }
              }
            )
          },
          s.name
        ))
      }
    ),
    /* @__PURE__ */ jsx23("div", { className: "mt-2 flex items-center gap-1.5", children: segments.map((s) => /* @__PURE__ */ jsxs20(
      "button",
      {
        type: "button",
        "aria-pressed": selected === s.name,
        onClick: () => setSelected(s.name),
        className: `flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] transition-[background-color,color,transform] duration-150 active:scale-[0.96] ${selected === s.name ? "bg-field text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`,
        children: [
          /* @__PURE__ */ jsx23("span", { className: `size-1.5 rounded-full ${s.cls}` }),
          s.name,
          " ",
          /* @__PURE__ */ jsxs20("span", { className: "tabular-nums", children: [
            s.pct,
            "%"
          ] })
        ]
      },
      s.name
    )) }),
    /* @__PURE__ */ jsxs20("div", { className: "mt-3 min-h-16 rounded-control bg-inset px-2.5 py-2 shadow-hairline", children: [
      /* @__PURE__ */ jsx23("span", { className: `block text-[11.5px] font-medium ${active.tone}`, children: active.label }),
      /* @__PURE__ */ jsx23("span", { className: "mt-1 block text-[11px] leading-relaxed text-ink-3", children: "Illustrative partner mix. Select a role to inspect its share; this is not live program data." })
    ] })
  ] });
}
var PAGES = [
  { key: "compare", prose: /* @__PURE__ */ jsxs20(Fragment7, { children: [
    "Compare evidence coverage across ",
    /* @__PURE__ */ jsx23(Entity, { name: "Partner Program", tone: "bg-accent" }),
    " reviews. Values below are illustrative."
  ] }), Card: CompareCard, pill: "Show the evidence gaps" },
  { key: "anomaly", prose: /* @__PURE__ */ jsx23(Fragment7, { children: "This sample queue grows from 2 to 8 reviews. Maya can inspect what is waiting before starting another batch." }), Card: AnomalyCard, pill: "Open the review queue" },
  { key: "allocation", prose: /* @__PURE__ */ jsx23(Fragment7, { children: "Explore a proposed mix of partner roles. This sample does not represent Hermes program enrollment." }), Card: AllocationCard, pill: "Compare partner roles" }
];
var DEFAULT_INSIGHT_LABELS = {
  title: "Insights"
};
function InsightCards({
  pages = PAGES,
  labels,
  initialPage = 0,
  onAction,
  onPageChange
} = {}) {
  const l = { ...DEFAULT_INSIGHT_LABELS, ...labels };
  const reduce = useReducedMotion();
  const [page, setPage] = useState20(initialPage);
  const move = (direction) => {
    if (!pages.length) return;
    const next = (page + direction + pages.length) % pages.length;
    setPage(next);
    onPageChange?.(pages[next]);
  };
  const active = pages[page] ?? pages[0];
  if (!active) return null;
  const { prose, Card, pill } = active;
  return /* @__PURE__ */ jsxs20("div", { "data-reduced-motion": reduce, className: "hermes-ui min-h-[408px] w-full max-w-86", children: [
    /* @__PURE__ */ jsxs20("div", { className: "flex items-center justify-between", children: [
      /* @__PURE__ */ jsxs20("span", { className: "flex items-baseline gap-1.5", children: [
        /* @__PURE__ */ jsx23("span", { className: "text-[13px] font-semibold text-ink", children: l.title }),
        /* @__PURE__ */ jsx23("span", { className: "text-[13px] text-ink-3 tabular-nums", children: pages.length })
      ] }),
      /* @__PURE__ */ jsx23("span", { className: "flex items-center gap-0.5", children: ["M15 18l-6-6 6-6", "M9 6l6 6-6 6"].map((d, i) => /* @__PURE__ */ jsx23(
        "button",
        {
          "aria-label": i === 0 ? "Previous insight" : "Next insight",
          onClick: () => move(i === 0 ? -1 : 1),
          className: "flex size-6 items-center justify-center rounded-[6px] text-ink-3\n                transition-[background-color,color,transform] duration-100 hover:bg-hover\n                hover:text-ink active:scale-[0.96]",
          children: /* @__PURE__ */ jsx23("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx23("path", { d }) })
        },
        i
      )) })
    ] }),
    /* @__PURE__ */ jsxs20(
      "div",
      {
        className: "transition-[opacity,filter] duration-250",
        style: { opacity: 1, filter: "blur(0)" },
        children: [
          /* @__PURE__ */ jsx23("p", { className: "mt-1.5 text-[12.5px] leading-relaxed text-ink-2", children: prose }),
          /* @__PURE__ */ jsx23("div", { className: "mt-2", children: /* @__PURE__ */ jsx23(Card, {}) }),
          /* @__PURE__ */ jsx23(
            "button",
            {
              type: "button",
              disabled: !onAction,
              onClick: () => onAction?.(active),
              className: "mt-2 rounded-full bg-surface px-3 py-1.5 text-left text-[12px] text-ink\n            shadow-btn transition-colors duration-100 hover:bg-hover",
              children: pill
            }
          )
        ]
      }
    )
  ] });
}

// src/components/primitives/CodeBlock.tsx
import { useCallback, useEffect as useEffect17, useRef as useRef15, useState as useState21 } from "react";
import { Fragment as Fragment8, jsx as jsx24, jsxs as jsxs21 } from "react/jsx-runtime";
var FILE = "partner-review.ts";
var CODE_LINES = [
  "export async function reviewPartner(application) {",
  '  const criteria = await read("Partner criteria v2");',
  "  const report = await screen(application, criteria);",
  '  report.evidenceOrder = "gaps-first";',
  '  report.requiredReviewer = "Maya Chen";',
  "  return queueReview(report, { send: false });",
  "}"
];
var DIFF = [
  { old: 1, cur: 1, type: "ctx", pieces: [{ text: CODE_LINES[0] }] },
  { old: 2, cur: 2, type: "ctx", pieces: [{ text: CODE_LINES[1] }] },
  { old: 3, cur: 3, type: "ctx", pieces: [{ text: CODE_LINES[2] }] },
  { old: 4, cur: null, type: "del", pieces: [{ text: "  report.evidenceOrder = " }, { text: '"source-order"', change: "del" }, { text: ";" }] },
  { old: null, cur: 4, type: "add", pieces: [{ text: "  report.evidenceOrder = " }, { text: '"gaps-first"', change: "add" }, { text: ";" }] },
  { old: 5, cur: 5, type: "ctx", pieces: [{ text: CODE_LINES[4] }] },
  { old: 6, cur: 6, type: "ctx", pieces: [{ text: CODE_LINES[5] }] },
  { old: 7, cur: 7, type: "ctx", pieces: [{ text: CODE_LINES[6] }] }
];
var HATCH = "repeating-linear-gradient(45deg, var(--red) 0, var(--red) 1.5px, transparent 1.5px, transparent 3px)";
var KEYWORDS = /* @__PURE__ */ new Set(["import", "from", "export", "default", "async", "function", "const", "let", "var", "await", "return", "if", "else", "for", "while", "new", "throw", "try", "catch", "null", "true", "false", "undefined"]);
var TOKEN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined)\b|[A-Za-z_$][A-Za-z0-9_$]*)/g;
function isFunctionCall(text, tokenEnd) {
  let cursor = tokenEnd;
  while (text[cursor] === " " || text[cursor] === "	") cursor += 1;
  return text[cursor] === "(";
}
function highlight(text) {
  const nodes = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    const t = m[0];
    let color;
    let weight;
    if (/^["'`]/.test(t) || /^\d/.test(t)) color = "var(--orange)";
    else if (KEYWORDS.has(t)) color = "var(--accent-ink)";
    else if (isFunctionCall(text, idx + t.length)) {
      color = "var(--ink)";
      weight = 500;
    } else continue;
    if (idx > last) nodes.push(/* @__PURE__ */ jsx24("span", { children: text.slice(last, idx) }, k++));
    nodes.push(/* @__PURE__ */ jsx24("span", { style: { color, fontWeight: weight }, children: t }, k++));
    last = idx + t.length;
  }
  if (last < text.length) nodes.push(/* @__PURE__ */ jsx24("span", { children: text.slice(last) }, k++));
  return nodes;
}
function Pieces({ pieces }) {
  return /* @__PURE__ */ jsx24(Fragment8, { children: pieces.map((p, i) => {
    if (p.change) {
      const add = p.change === "add";
      return /* @__PURE__ */ jsx24(
        "span",
        {
          className: "rounded-[3px]",
          style: {
            background: `color-mix(in srgb, var(--${add ? "green" : "red"}) 18%, transparent)`,
            padding: "0 2px",
            margin: "0 -1px",
            boxDecorationBreak: "clone",
            WebkitBoxDecorationBreak: "clone"
          },
          children: highlight(p.text)
        },
        i
      );
    }
    return /* @__PURE__ */ jsx24("span", { children: highlight(p.text) }, i);
  }) });
}
function FileIcon() {
  return /* @__PURE__ */ jsx24("svg", { "aria-hidden": true, width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", className: "shrink-0 text-ink-3", children: /* @__PURE__ */ jsx24("path", { d: "M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" }) });
}
var DEFAULT_LABELS8 = { copy: "Copy", copied: "Copied" };
function CodeBlock({
  variant = "Code",
  lines = CODE_LINES,
  code,
  diff = DIFF,
  filename = FILE,
  labels,
  onCopy,
  onCopyError
} = {}) {
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState21(false);
  const isDiff = variant === "Diff";
  const text = { ...DEFAULT_LABELS8, ...labels };
  const raw = code ?? lines.join("\n");
  const resetTimer = useRef15(null);
  const [copyError, setCopyError] = useState21(false);
  useEffect17(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);
  const copy = useCallback(async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      onCopy?.(raw);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      setCopied(false);
      setCopyError(true);
      onCopyError?.(error);
    }
  }, [raw, onCopy, onCopyError]);
  const added = diff.filter((r) => r.type === "add").length;
  const removed = diff.filter((r) => r.type === "del").length;
  return /* @__PURE__ */ jsxs21("div", { "data-reduced-motion": reduce, className: "hermes-ui w-full max-w-105 overflow-hidden rounded-card bg-surface shadow-card", children: [
    /* @__PURE__ */ jsxs21("div", { className: "flex h-11 items-center gap-2 border-b border-line px-4 text-[12.5px]", children: [
      /* @__PURE__ */ jsxs21("span", { className: "inline-flex min-w-0 items-center gap-[7px]", children: [
        /* @__PURE__ */ jsx24(FileIcon, {}),
        /* @__PURE__ */ jsx24("span", { className: "truncate font-mono leading-none text-ink", children: filename })
      ] }),
      isDiff ? /* @__PURE__ */ jsxs21("span", { className: "ml-auto inline-flex items-center gap-2 font-mono text-[12px] leading-none tabular-nums", children: [
        /* @__PURE__ */ jsxs21("span", { className: "text-green", children: [
          "+",
          added
        ] }),
        /* @__PURE__ */ jsxs21("span", { className: "text-red", children: [
          "-",
          removed
        ] })
      ] }) : /* @__PURE__ */ jsxs21(
        "button",
        {
          type: "button",
          "aria-label": "Copy code",
          onClick: copy,
          className: `-mr-1 ml-auto flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[12px]
              font-medium transition-colors duration-100 hover:bg-hover
              ${copied ? "text-green" : "text-ink-3 hover:text-ink"}`,
          children: [
            copied ? /* @__PURE__ */ jsx24("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "3", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx24("path", { d: "M20 6L9 17l-5-5" }) }) : /* @__PURE__ */ jsxs21("svg", { width: "11", height: "11", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [
              /* @__PURE__ */ jsx24("rect", { x: "9", y: "9", width: "12", height: "12", rx: "2.5" }),
              /* @__PURE__ */ jsx24("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
            ] }),
            copied ? text.copied : text.copy
          ]
        }
      )
    ] }),
    copyError && /* @__PURE__ */ jsx24("p", { role: "alert", className: "px-4 pt-2 text-[12px] text-red", children: "Clipboard unavailable. Select the text to copy." }),
    /* @__PURE__ */ jsx24("div", { className: "py-3 font-mono text-[12.5px] leading-[1.65] text-ink-2", children: isDiff ? /* @__PURE__ */ jsxs21("div", { className: "relative", children: [
      /* @__PURE__ */ jsx24("span", { className: "pointer-events-none absolute inset-y-0 left-5 w-px bg-line" }),
      diff.map((r, i) => {
        const add = r.type === "add";
        const del = r.type === "del";
        const num = del ? r.old : r.cur;
        return /* @__PURE__ */ jsxs21(
          "div",
          {
            className: `relative grid grid-cols-[20px_minmax(0,1fr)] items-start
                    ${add ? "bg-green-tint" : del ? "bg-red-tint" : ""}`,
            children: [
              (add || del) && /* @__PURE__ */ jsx24("span", { className: "absolute inset-y-0 left-0 w-[3px]", style: { background: add ? "var(--green)" : HATCH } }),
              /* @__PURE__ */ jsx24("span", { className: `select-none text-center text-[11px] ${add ? "text-green" : del ? "text-red" : "text-ink-3"}`, children: num ?? "" }),
              /* @__PURE__ */ jsx24("code", { className: "pr-3 pl-1 break-words whitespace-pre-wrap", children: /* @__PURE__ */ jsx24(Pieces, { pieces: r.pieces }) })
            ]
          },
          i
        );
      })
    ] }) : /* @__PURE__ */ jsxs21("div", { className: "relative", children: [
      /* @__PURE__ */ jsx24("span", { className: "pointer-events-none absolute inset-y-0 left-5 w-px bg-line" }),
      lines.map((line, i) => /* @__PURE__ */ jsxs21("div", { className: "grid grid-cols-[20px_minmax(0,1fr)] items-start", children: [
        /* @__PURE__ */ jsx24("span", { className: "select-none text-center text-[11px] text-ink-3", children: i + 1 }),
        /* @__PURE__ */ jsx24("code", { className: "pr-3 pl-1 break-words whitespace-pre-wrap", children: highlight(line) })
      ] }, i))
    ] }) })
  ] });
}

// src/components/primitives/FineTuneCard.tsx
import { useEffect as useEffect18, useRef as useRef16, useState as useState22 } from "react";
import { jsx as jsx25, jsxs as jsxs22 } from "react/jsx-runtime";
function ScrubField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix = "",
  active
}) {
  const drag = useRef16(null);
  const clamp = (v) => Math.min(max, Math.max(min, Math.round(v)));
  return /* @__PURE__ */ jsxs22(
    "label",
    {
      className: "flex h-6.5 min-w-0 items-center gap-1 rounded-chip py-1 pr-1 pl-0.5\n        transition-[background-color,box-shadow] duration-200",
      style: {
        background: active ? "var(--accent-tint)" : "var(--field)",
        boxShadow: active ? "0 0 0 1px var(--accent)" : "none"
      },
      children: [
        /* @__PURE__ */ jsx25(
          "span",
          {
            role: "slider",
            "aria-label": label,
            "aria-valuenow": value,
            "aria-valuemin": min,
            "aria-valuemax": max,
            tabIndex: 0,
            onPointerDown: (e) => {
              e.target.setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, v: value };
            },
            onPointerMove: (e) => {
              if (!drag.current) return;
              onChange(clamp(drag.current.v + (e.clientX - drag.current.x) / 2 * step));
            },
            onPointerUp: () => drag.current = null,
            onPointerCancel: () => drag.current = null,
            onLostPointerCapture: () => drag.current = null,
            onKeyDown: (e) => {
              const mult = e.shiftKey ? 10 : 1;
              if (e.key === "Home") {
                e.preventDefault();
                onChange(min);
              }
              if (e.key === "End") {
                e.preventDefault();
                onChange(max);
              }
              if (e.key === "ArrowUp" || e.key === "ArrowRight") {
                e.preventDefault();
                onChange(clamp(value + step * mult));
              } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
                e.preventDefault();
                onChange(clamp(value - step * mult));
              }
            },
            className: "flex h-full shrink-0 cursor-ew-resize touch-none items-center rounded-[4px]\n          px-0.5 text-[12px] text-ink-3 select-none hover:text-ink-2 focus-visible:text-accent-ink\n          focus-visible:outline-none",
            children: label
          }
        ),
        /* @__PURE__ */ jsx25(
          "input",
          {
            inputMode: "numeric",
            value,
            onChange: (e) => {
              const n = Number(e.target.value.replace(/[^\d-]/g, ""));
              if (!Number.isNaN(n)) onChange(clamp(n));
            },
            "aria-label": `${label} value`,
            className: "min-w-0 flex-1 bg-transparent text-[12px] text-ink tabular-nums outline-none"
          }
        ),
        suffix && /* @__PURE__ */ jsx25("span", { className: "shrink-0 pr-0.5 text-[11.5px] text-ink-3", children: suffix })
      ]
    }
  );
}
var SEGMENTS = ["row", "col", "grid"];
function SegmentIcon({ kind }) {
  const dot = "size-1.5 rounded-[2px] border-[1.2px] border-current";
  if (kind === "row")
    return /* @__PURE__ */ jsx25("span", { className: "flex gap-0.5", children: [0, 1, 2].map((i) => /* @__PURE__ */ jsx25("span", { className: dot }, i)) });
  if (kind === "col")
    return /* @__PURE__ */ jsx25("span", { className: "flex flex-col gap-0.5", children: [0, 1].map((i) => /* @__PURE__ */ jsx25("span", { className: dot }, i)) });
  return /* @__PURE__ */ jsx25("span", { className: "grid grid-cols-2 gap-0.5", children: [0, 1, 2, 3].map((i) => /* @__PURE__ */ jsx25("span", { className: dot }, i)) });
}
var FIELDS = [
  { key: "width", label: "W", value: 324, min: 40, max: 999 },
  { key: "height", label: "H", value: 96, min: 24, max: 999 },
  { key: "radius", label: "Radius", value: 12, min: 0, max: 64 },
  { key: "opacity", label: "Opacity", value: 100, min: 0, max: 100, suffix: "%" }
];
var OPTIONS2 = ["Context", "Review", "Result"];
var DEFAULT_LABELS9 = {
  title: "Context card",
  layout: "Layout",
  type: "Type",
  placeholder: "Select type",
  adjust: "Adjust",
  edited: "Edited"
};
function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
function FineTuneCard({
  fields = FIELDS,
  options = OPTIONS2,
  labels,
  onChange
} = {}) {
  const text = { ...DEFAULT_LABELS9, ...labels };
  const [seg, setSeg] = useState22(0);
  const [values, setValues] = useState22(
    () => Object.fromEntries(fields.map((f) => [f.key, f.value]))
  );
  const [menuOpen, setMenuOpen] = useState22(false);
  const menuRef = useRef16(null);
  const menuButtonRef = useRef16(null);
  useEffect18(() => {
    if (!menuOpen) return;
    const pointer = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const key = (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [menuOpen]);
  const [typeValue, setTypeValue] = useState22(text.placeholder);
  const selectSeg = (i) => {
    setSeg(i);
    onChange?.({ segment: i, values, type: typeValue });
  };
  const setValue = (key, v) => {
    const next = { ...values, [key]: v };
    setValues(next);
    onChange?.({ segment: seg, values: next, type: typeValue });
  };
  const selectType = (value) => {
    setTypeValue(value);
    setMenuOpen(false);
    menuButtonRef.current?.focus();
    onChange?.({ segment: seg, values, type: value });
  };
  const changed = fields.some((f) => values[f.key] !== f.value);
  const done = seg !== 0 || changed || typeValue !== text.placeholder;
  return /* @__PURE__ */ jsxs22("div", { className: "relative w-full max-w-60 rounded-card bg-surface shadow-raised", children: [
    /* @__PURE__ */ jsxs22("div", { className: "primitive-card-bar flex items-center justify-between border-b border-line", children: [
      /* @__PURE__ */ jsx25("span", { className: "text-[13px] font-medium text-ink", children: text.title }),
      done ? /* @__PURE__ */ jsxs22(
        "span",
        {
          className: "flex items-center gap-1.5 text-[12px] font-medium text-green",
          style: { animation: "pop-in 250ms cubic-bezier(0.23,1,0.32,1) both" },
          children: [
            /* @__PURE__ */ jsx25("svg", { width: "10", height: "10", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "3", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsx25("path", { d: "M20 6L9 17l-5-5" }) }),
            text.edited
          ]
        }
      ) : /* @__PURE__ */ jsxs22("span", { className: "flex items-center gap-1.5", children: [
        /* @__PURE__ */ jsx25("span", { className: "flex size-4.5 items-center justify-center rounded-[5px] border border-accent-ink/30 bg-accent-tint", children: /* @__PURE__ */ jsx25("svg", { width: "9", height: "9", viewBox: "0 0 24 24", fill: "var(--accent-ink)", children: /* @__PURE__ */ jsx25("path", { d: "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" }) }) }),
        /* @__PURE__ */ jsx25(
          "span",
          {
            className: "bg-clip-text text-[12px] font-medium text-transparent",
            style: {
              backgroundImage: "linear-gradient(90deg, var(--accent-ink) 35%, var(--ink) 50%, var(--accent-ink) 65%)",
              backgroundSize: "200% 100%",
              animation: "shimmer-text 1.4s linear infinite"
            },
            children: text.adjust
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs22("div", { className: "primitive-card-pad flex flex-col gap-2 border-b border-line", children: [
      /* @__PURE__ */ jsx25("p", { className: "text-[12.5px] font-medium text-ink", children: text.layout }),
      /* @__PURE__ */ jsxs22("div", { className: "relative grid grid-cols-3 rounded-control bg-field p-0.5", children: [
        /* @__PURE__ */ jsx25(
          "span",
          {
            "aria-hidden": true,
            className: "absolute inset-y-0.5 rounded-[6px] bg-surface shadow-btn transition-transform duration-300",
            style: {
              width: "calc((100% - 4px) / 3)",
              left: 2,
              transform: `translateX(${seg * 100}%)`,
              transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)"
            }
          }
        ),
        SEGMENTS.map((s, i) => /* @__PURE__ */ jsx25(
          "button",
          {
            type: "button",
            "aria-label": `${s} layout`,
            "aria-pressed": i === seg,
            onClick: () => selectSeg(i),
            className: `relative z-10 flex h-6 items-center justify-center transition-colors duration-200
                ${i === seg ? "text-accent-ink" : "text-ink-3"}`,
            children: /* @__PURE__ */ jsx25(SegmentIcon, { kind: s })
          },
          s
        ))
      ] }),
      chunk(fields, 2).map((pair, ri) => /* @__PURE__ */ jsx25("div", { className: "grid min-w-0 grid-cols-2 gap-2", children: pair.map((f) => /* @__PURE__ */ jsx25(
        ScrubField,
        {
          label: f.label,
          value: values[f.key],
          onChange: (v) => setValue(f.key, v),
          min: f.min,
          max: f.max,
          step: f.step,
          suffix: f.suffix,
          active: values[f.key] !== f.value
        },
        f.key
      )) }, ri))
    ] }),
    /* @__PURE__ */ jsxs22("div", { className: "primitive-card-footer flex items-center justify-between", children: [
      /* @__PURE__ */ jsx25("span", { className: "text-[12px] text-ink-3", children: text.type }),
      /* @__PURE__ */ jsxs22("div", { ref: menuRef, className: "relative -mr-0.5 w-30", children: [
        /* @__PURE__ */ jsxs22(
          "button",
          {
            type: "button",
            ref: menuButtonRef,
            "aria-label": "Card type",
            "aria-expanded": menuOpen,
            onClick: () => setMenuOpen((current) => !current),
            className: "flex h-6.5 w-full items-center justify-between rounded-chip bg-inset py-1 pr-1 pl-2\n              shadow-hairline transition-shadow duration-200 focus-visible:outline-none",
            style: { boxShadow: menuOpen ? "0 0 0 1px var(--accent)" : void 0 },
            children: [
              /* @__PURE__ */ jsx25("span", { className: `text-[12px] ${typeValue !== text.placeholder ? "text-ink" : "text-ink-3"}`, children: typeValue }),
              /* @__PURE__ */ jsx25(
                "svg",
                {
                  width: "11",
                  height: "11",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "var(--ink-3)",
                  strokeWidth: "2.5",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  className: "transition-transform duration-200",
                  style: { transform: menuOpen ? "rotate(180deg)" : "rotate(0)" },
                  children: /* @__PURE__ */ jsx25("path", { d: "M6 9l6 6 6-6" })
                }
              )
            ]
          }
        ),
        menuOpen && /* @__PURE__ */ jsx25(
          "div",
          {
            className: "absolute right-0 bottom-8 z-10 w-30 rounded-[10px] bg-surface p-1 shadow-raised",
            style: {
              animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both",
              transformOrigin: "bottom right"
            },
            children: /* @__PURE__ */ jsx25(GlideMenu, { className: "flex flex-col gap-px", highlightClassName: "inset-x-0 rounded-[6px] bg-field", children: options.map((item) => /* @__PURE__ */ jsx25(
              "button",
              {
                "data-menu-row": true,
                type: "button",
                onClick: () => selectType(item),
                className: `relative z-10 flex h-6.5 w-full items-center rounded-[6px] px-2 text-left text-[12.5px] text-ink ${item === typeValue ? "bg-field group-hover/glide-menu:bg-transparent" : ""}`,
                children: item
              },
              item
            )) })
          }
        )
      ] })
    ] })
  ] });
}

// src/components/primitives/SelectionActions.tsx
import {
  useCallback as useCallback2,
  useEffect as useEffect20,
  useLayoutEffect as useLayoutEffect6,
  useRef as useRef18,
  useState as useState24
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
  Xmark
} from "iconoir-react";

// src/components/atoms/Shimmer.tsx
import { jsx as jsx26 } from "react/jsx-runtime";
function Shimmer({
  children,
  className = ""
}) {
  return /* @__PURE__ */ jsx26(
    "span",
    {
      className: `inline-block bg-clip-text text-transparent ${className}`,
      style: {
        backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
        backgroundSize: "200% 100%",
        animation: "shimmer-text 1.8s linear infinite"
      },
      children
    }
  );
}

// src/components/atoms/StreamText.tsx
import { useEffect as useEffect19, useRef as useRef17, useState as useState23 } from "react";
import { jsx as jsx27, jsxs as jsxs23 } from "react/jsx-runtime";
function StreamText({
  text,
  charsPerTick = 2,
  tickMs = 9,
  blurTail = 6,
  caret = true,
  className,
  onProgress,
  onDone
}) {
  const reduce = useReducedMotion();
  const [count, setCount] = useState23(0);
  const onProgressRef = useRef17(onProgress);
  const onDoneRef = useRef17(onDone);
  onProgressRef.current = onProgress;
  onDoneRef.current = onDone;
  useEffect19(() => {
    if (reduce) {
      setCount(text.length);
      onDoneRef.current?.();
      return;
    }
    setCount(0);
    let i = 0;
    const id = setInterval(() => {
      i = Math.min(i + charsPerTick, text.length);
      setCount(i);
      onProgressRef.current?.();
      if (i >= text.length) {
        clearInterval(id);
        onDoneRef.current?.();
      }
    }, tickMs);
    return () => clearInterval(id);
  }, [text, charsPerTick, tickMs, reduce]);
  const streaming = count < text.length;
  const shown = text.slice(0, count);
  const split = streaming ? Math.max(0, shown.length - blurTail) : shown.length;
  return /* @__PURE__ */ jsxs23("span", { className, children: [
    shown.slice(0, split),
    split < shown.length && /* @__PURE__ */ jsx27("span", { className: "stream-tail", children: shown.slice(split) }),
    caret && /* @__PURE__ */ jsx27(
      "span",
      {
        "aria-hidden": true,
        className: `stream-caret${streaming ? " is-streaming" : ""}`
      }
    )
  ] });
}

// src/components/primitives/SelectionActions.tsx
import { Fragment as Fragment9, jsx as jsx28, jsxs as jsxs24 } from "react/jsx-runtime";
var LEAD = "Iris screens every new application. ";
var PICKED = "Check integration experience and public evidence, then send the application to Maya for a decision.";
var REWRITE = "Check integration experience and public work. Send Maya the evidence and a recommendation.";
var DEFAULT_TEXT = {
  lead: LEAD,
  original: PICKED,
  rewrite: REWRITE
};
var DEFAULT_LABELS10 = {
  keep: "Keep",
  discard: "Discard",
  placeholder: "Describe edits"
};
var iconProps = {
  width: 14,
  height: 14,
  strokeWidth: 1.8,
  "aria-hidden": true
};
var icons = {
  explain: /* @__PURE__ */ jsx28(ChatBubbleQuestion, { ...iconProps }),
  improve: /* @__PURE__ */ jsx28(Spark, { ...iconProps }),
  shorten: /* @__PURE__ */ jsx28(Scissor, { ...iconProps }),
  tone: /* @__PURE__ */ jsx28(EmojiSatisfied, { ...iconProps }),
  grammar: /* @__PURE__ */ jsx28(TextBox, { ...iconProps }),
  send: /* @__PURE__ */ jsx28(
    ArrowUp,
    {
      width: "16",
      height: "16",
      strokeWidth: "2.4",
      "aria-hidden": "true"
    }
  ),
  chevron: /* @__PURE__ */ jsx28(NavArrowRight, { ...iconProps }),
  check: /* @__PURE__ */ jsx28(Check, { ...iconProps }),
  close: /* @__PURE__ */ jsx28(Xmark, { ...iconProps }),
  retry: /* @__PURE__ */ jsx28(Refresh, { ...iconProps })
};
var primary = "inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink px-2.5 text-[12.5px] font-normal text-canvas shadow-hairline transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.96]";
var DEFAULT_ACTIONS = {
  primary: [
    { id: "Explain", icon: icons.explain, action: "Explain", busyLabel: "Explaining" },
    { id: "Improve", icon: icons.improve, action: "Improve", busyLabel: "Improving" }
  ],
  more: [
    { id: "Shorten", icon: icons.shorten, action: "Shorten", busyLabel: "Shortening" },
    { id: "Tone", icon: icons.tone, action: "Change tone", busyLabel: "Changing tone" },
    { id: "Grammar", icon: icons.grammar, action: "Fix grammar" }
  ]
};
function SelectionActions({
  text: textProp,
  actions = DEFAULT_ACTIONS,
  labels,
  onAction,
  onRequestEdit,
  onKeep,
  onDiscard,
  explanation = "Iris gathers evidence. Maya decides whether the applicant joins the program."
} = {}) {
  const reduce = useReducedMotion();
  const passage = { ...DEFAULT_TEXT, ...textProp };
  const [accepted, setAccepted] = useState24(null);
  const [resultText, setResultText] = useState24(passage.rewrite);
  const [error, setError] = useState24("");
  const requestVersion = useRef18(0);
  const copy = { ...DEFAULT_LABELS10, ...labels };
  const [shown, setShown] = useState24(false);
  const [mode, setMode] = useState24("idle");
  const [action, setAction] = useState24("Improve");
  const [prompt, setPrompt] = useState24("");
  const [typingWidth, setTypingWidth] = useState24(null);
  const [expanded, setExpanded] = useState24(false);
  const [anchor, setAnchor] = useState24({ x: 0, y: 0 });
  const [positioned, setPositioned] = useState24(false);
  const hostRef = useRef18(null);
  const selectionRef = useRef18(null);
  const barRef = useRef18(null);
  const contentRef = useRef18(null);
  const frameRef = useRef18(null);
  const previousModeRef = useRef18("idle");
  const lastWidthRef = useRef18(0);
  const widthAnimationRef = useRef18(null);
  useEffect20(() => {
    const timer = window.setTimeout(() => setShown(true), 280);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect20(() => {
    if (mode !== "thinking" || onRequestEdit) return;
    const timer = window.setTimeout(() => setMode("streaming"), 700);
    return () => window.clearTimeout(timer);
  }, [mode, onRequestEdit]);
  const place = useCallback2(() => {
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
        y: Math.round(lastLine.bottom - hostBounds.top + 8)
      };
      setAnchor(
        (current) => current.x === next.x && current.y === next.y ? current : next
      );
      setPositioned(true);
    });
  }, []);
  useLayoutEffect6(() => {
    place();
  }, [mode, place]);
  useEffect20(() => {
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
  useLayoutEffect6(() => {
    const bar = barRef.current;
    const content = contentRef.current;
    if (!bar || !content) return;
    const nextWidth = Math.ceil(content.getBoundingClientRect().width) + 8;
    const previousWidth = lastWidthRef.current || Math.ceil(bar.getBoundingClientRect().width);
    if (!reduce && previousModeRef.current !== mode && Math.abs(nextWidth - previousWidth) > 1) {
      widthAnimationRef.current?.cancel();
      const animation = bar.animate(
        [
          { width: `${previousWidth}px` },
          { width: `${nextWidth}px` }
        ],
        {
          duration: 320,
          easing: "cubic-bezier(0.23,1,0.32,1)"
        }
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
  useEffect20(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (widthAnimationRef.current?.playState === "running") return;
      lastWidthRef.current = Math.ceil(content.getBoundingClientRect().width) + 8;
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      widthAnimationRef.current?.cancel();
    };
  }, []);
  useEffect20(() => () => {
    requestVersion.current += 1;
  }, []);
  const run = async (nextAction) => {
    const version = ++requestVersion.current;
    setAction(nextAction);
    setError("");
    setExpanded(false);
    setResultText(nextAction === "Explain" ? explanation : passage.rewrite);
    setMode("thinking");
    onAction?.(nextAction);
    if (!onRequestEdit) return;
    try {
      const result = await onRequestEdit(nextAction, accepted ?? passage.original);
      if (version === requestVersion.current) {
        setResultText(result);
        setMode("streaming");
      }
    } catch {
      if (version === requestVersion.current) {
        setMode("idle");
        setError("Couldn't apply the edit. Try again.");
      }
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
  const keep = () => {
    if (action !== "Explain") {
      setAccepted(resultText);
      onKeep?.(resultText);
    }
    reset();
  };
  const discard = () => {
    onDiscard?.();
    reset();
  };
  const busy = mode === "thinking" || mode === "streaming";
  const visible = shown && positioned;
  const hasPrompt = prompt.trim().length > 0;
  const busyLabelMap = {};
  for (const item of [...actions.primary, ...actions.more]) {
    if (item.action && item.busyLabel) busyLabelMap[item.action] = item.busyLabel;
  }
  const busyLabel = busyLabelMap[action] ?? "Editing";
  return /* @__PURE__ */ jsx28("div", { className: "w-full max-w-[460px]", children: /* @__PURE__ */ jsxs24("div", { ref: hostRef, className: "relative pb-12", children: [
    /* @__PURE__ */ jsxs24("p", { className: "text-[13px] leading-relaxed text-ink", children: [
      passage.lead,
      /* @__PURE__ */ jsx28(
        "span",
        {
          ref: selectionRef,
          tabIndex: 0,
          role: "button",
          "aria-label": "Edit selected passage",
          onClick: () => setShown(true),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShown(true);
            }
          },
          className: "box-decoration-clone rounded-[3px] bg-[color-mix(in_srgb,var(--accent)_14%,var(--surface))] text-ink dark:bg-accent-tint",
          children: mode === "idle" || mode === "thinking" || action === "Explain" ? accepted ?? passage.original : mode === "streaming" ? /* @__PURE__ */ jsx28(
            StreamText,
            {
              text: resultText,
              onProgress: place,
              onDone: () => setMode("result")
            }
          ) : resultText
        }
      )
    ] }),
    action === "Explain" && (mode === "streaming" || mode === "result") && /* @__PURE__ */ jsx28("p", { className: "mt-14 rounded-control bg-field p-3 text-[13px] text-ink-2", role: "status", children: mode === "streaming" ? /* @__PURE__ */ jsx28(StreamText, { text: resultText, onDone: () => setMode("result") }) : resultText }),
    error && /* @__PURE__ */ jsx28("p", { className: "mt-2 text-[12px] text-red", role: "alert", children: error }),
    /* @__PURE__ */ jsx28(
      "div",
      {
        className: "absolute top-0 left-0 z-10",
        style: {
          transform: `translate3d(${anchor.x}px, ${anchor.y}px, 0) translateX(-50%)`,
          transition: "transform 320ms cubic-bezier(0.77,0,0.175,1), opacity 180ms ease-out",
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? "auto" : "none",
          willChange: "transform"
        },
        children: /* @__PURE__ */ jsx28(
          "div",
          {
            ref: barRef,
            className: "selection-toolbar flex h-10 w-fit max-w-[min(460px,calc(100vw-64px))] items-center gap-0.5 overflow-x-auto overflow-y-hidden rounded-full bg-surface p-1 font-sans font-normal text-ink shadow-overlay",
            style: {
              width: mode === "idle" && hasPrompt && typingWidth ? typingWidth : void 0,
              ...visible ? {
                animation: "pop-in 220ms cubic-bezier(0.23,1,0.32,1) both"
              } : {}
            },
            children: /* @__PURE__ */ jsxs24(
              "div",
              {
                ref: contentRef,
                className: "flex w-fit shrink-0 items-center justify-center gap-0.5",
                style: {
                  width: mode === "idle" && hasPrompt && typingWidth ? typingWidth - 8 : void 0
                },
                children: [
                  busy && /* @__PURE__ */ jsxs24("span", { className: "inline-flex h-7 items-center gap-1.5 whitespace-nowrap px-2.5 text-[12.5px] font-normal text-ink-2", children: [
                    /* @__PURE__ */ jsx28(
                      "span",
                      {
                        className: "size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2",
                        style: { animation: reduce ? "none" : "spin 700ms linear infinite" }
                      }
                    ),
                    mode === "thinking" ? /* @__PURE__ */ jsxs24(Shimmer, { className: "text-[12.5px] font-normal", children: [
                      busyLabel,
                      "\u2026"
                    ] }) : /* @__PURE__ */ jsxs24("span", { children: [
                      busyLabel,
                      "\u2026"
                    ] })
                  ] }),
                  mode === "result" && /* @__PURE__ */ jsxs24(Fragment9, { children: [
                    /* @__PURE__ */ jsxs24(
                      "button",
                      {
                        type: "button",
                        onClick: keep,
                        className: primary,
                        children: [
                          icons.check,
                          action === "Explain" ? "Done" : copy.keep
                        ]
                      }
                    ),
                    /* @__PURE__ */ jsxs24(Button, { type: "button", variant: "quiet", size: "xs", className: "shrink-0", onClick: discard, children: [
                      icons.close,
                      copy.discard
                    ] }),
                    /* @__PURE__ */ jsx28("span", { className: "mx-0.5 h-4 w-px shrink-0 bg-line" }),
                    /* @__PURE__ */ jsx28(
                      "button",
                      {
                        type: "button",
                        "aria-label": "Try again",
                        onClick: () => run(action),
                        className: "flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink-2 active:scale-[0.96]",
                        children: icons.retry
                      }
                    )
                  ] }),
                  mode === "idle" && /* @__PURE__ */ jsxs24(Fragment9, { children: [
                    /* @__PURE__ */ jsx28(
                      "div",
                      {
                        className: "flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-400",
                        style: {
                          maxWidth: expanded ? 0 : hasPrompt && typingWidth ? typingWidth - 40 : 145,
                          opacity: expanded ? 0 : 1,
                          transform: expanded ? "translateX(-8px)" : "translateX(0)",
                          transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)"
                        },
                        children: /* @__PURE__ */ jsx28(
                          "form",
                          {
                            inert: expanded,
                            className: "flex h-7 shrink-0 items-center transition-[width] duration-400",
                            style: {
                              width: hasPrompt && typingWidth ? typingWidth - 40 : 145,
                              transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)"
                            },
                            onSubmit: (event) => {
                              event.preventDefault();
                              run(prompt.trim() || "Improve");
                            },
                            children: /* @__PURE__ */ jsx28(
                              "input",
                              {
                                value: prompt,
                                onChange: (event) => {
                                  const next = event.target.value;
                                  if (!prompt.trim() && next.trim()) {
                                    setTypingWidth(
                                      Math.ceil(
                                        barRef.current?.getBoundingClientRect().width ?? 0
                                      )
                                    );
                                  } else if (!next.trim()) {
                                    setTypingWidth(null);
                                  }
                                  setPrompt(next);
                                },
                                "aria-label": copy.placeholder,
                                placeholder: copy.placeholder,
                                className: "h-7 w-full bg-transparent pr-2.5 pl-3 text-[12.5px] text-ink placeholder:text-ink-3"
                              }
                            )
                          }
                        )
                      }
                    ),
                    /* @__PURE__ */ jsxs24(
                      "div",
                      {
                        inert: hasPrompt,
                        className: "flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity,transform] duration-400",
                        style: {
                          maxWidth: hasPrompt ? 0 : expanded ? 600 : 260,
                          opacity: hasPrompt ? 0 : 1,
                          transform: hasPrompt ? "translateX(-8px)" : "translateX(0)",
                          transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)"
                        },
                        children: [
                          !expanded && /* @__PURE__ */ jsx28("span", { className: "mx-1 h-4 w-px shrink-0 bg-line-strong" }),
                          actions.primary.map((item) => /* @__PURE__ */ jsxs24(
                            Button,
                            {
                              type: "button",
                              variant: "quiet",
                              size: "xs",
                              className: "shrink-0",
                              onClick: item.action ? () => run(item.action) : void 0,
                              children: [
                                item.icon,
                                item.id
                              ]
                            },
                            item.id
                          )),
                          /* @__PURE__ */ jsx28(
                            "div",
                            {
                              inert: !expanded,
                              className: "flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity,margin] duration-400",
                              style: {
                                maxWidth: expanded ? 262 : 0,
                                opacity: expanded ? 1 : 0,
                                marginLeft: expanded ? 2 : 0,
                                transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)"
                              },
                              children: actions.more.map((item) => /* @__PURE__ */ jsxs24(
                                Button,
                                {
                                  type: "button",
                                  variant: "quiet",
                                  size: "xs",
                                  className: "shrink-0",
                                  onClick: item.action ? () => run(item.action) : void 0,
                                  children: [
                                    item.icon,
                                    item.id
                                  ]
                                },
                                item.id
                              ))
                            }
                          ),
                          /* @__PURE__ */ jsx28("span", { className: "mx-0.5 h-4 w-px shrink-0 bg-line" }),
                          /* @__PURE__ */ jsx28(
                            "button",
                            {
                              type: "button",
                              "aria-label": expanded ? "Show fewer actions" : "Show more actions",
                              "aria-expanded": expanded,
                              onClick: () => setExpanded((value) => !value),
                              className: "flex size-7 shrink-0 items-center justify-center rounded-full text-ink transition-[background-color,transform] duration-200 hover:bg-hover active:scale-[0.96]",
                              children: /* @__PURE__ */ jsx28(
                                "span",
                                {
                                  className: "flex transition-transform duration-400",
                                  style: {
                                    transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                                    transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)"
                                  },
                                  children: icons.chevron
                                }
                              )
                            }
                          )
                        ]
                      }
                    ),
                    /* @__PURE__ */ jsx28(
                      "div",
                      {
                        inert: !hasPrompt,
                        className: "flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-400",
                        style: {
                          maxWidth: hasPrompt ? 30 : 0,
                          opacity: hasPrompt ? 1 : 0,
                          transform: hasPrompt ? "scale(1)" : "scale(0.88)",
                          transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)"
                        },
                        children: /* @__PURE__ */ jsx28(
                          "button",
                          {
                            type: "button",
                            "aria-label": "Send edit instruction",
                            onClick: () => run(prompt.trim()),
                            className: "flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-surface transition-[opacity,transform] duration-200 active:scale-[0.94]",
                            children: icons.send
                          }
                        )
                      }
                    )
                  ] })
                ]
              }
            )
          }
        )
      }
    )
  ] }) });
}
export {
  AgentScreen,
  ApprovalCard,
  Button,
  ChatComposer,
  CodeBlock,
  ContextCards,
  DiffTable,
  FilterTable,
  FineTuneCard,
  Flowchart,
  HermesMotionProvider,
  InsightCards,
  LoadingState,
  PartnerWorkspacePreview,
  PromptBar,
  RecommendationCard,
  RecordsTable,
  SearchList,
  SelectionActions,
  Shimmer,
  SidebarNav,
  StreamText,
  StreamingText,
  TaskRows,
  ThinkingState,
  ToolChips,
  useReducedMotion
};
