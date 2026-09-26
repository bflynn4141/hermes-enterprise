type Tone = "neutral" | "green" | "orange" | "red" | "accent";
/** Inline value badge — a plain value (a date, a name, a count) set off in
 *  prose. Softer than a StatusPill (no dot) and not a mono token (see Chip). */
export declare function ValuePill({ children, tone, className, }: {
    children: React.ReactNode;
    tone?: Tone;
    className?: string;
}): import("react").JSX.Element;
export {};
