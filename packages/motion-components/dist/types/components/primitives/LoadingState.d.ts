import { type ReactNode } from "react";
export default function LoadingState({ label, variant,
/** Optional media for the Context variant; otherwise use a supplied context node. */
videoSrc, context, active, }: {
    label?: string;
    variant?: string;
    videoSrc?: string;
    context?: ReactNode;
    active?: boolean;
}): import("react").JSX.Element;
