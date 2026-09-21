import { type ReactNode } from "react";
export type ThinkingRow = {
    primary: string;
    secondary?: string;
    mono?: boolean;
    add?: number;
    del?: number;
    href?: string;
};
export default function ThinkingState({ variant, onSettled, rows, active, done, icon, query, additionalSources, stage: controlledStage, }: {
    variant?: string;
    onSettled?: () => void;
    /** override the built-in trace content (keeps the primitive reusable) */
    rows?: ThinkingRow[];
    active?: string;
    done?: string;
    /** override the header glyph (defaults to the sparkle) */
    icon?: ReactNode;
    query?: string;
    additionalSources?: number;
    /** Optional externally supplied stage, 0–4; omit for the reference demonstration. */
    stage?: number;
}): import("react").JSX.Element;
