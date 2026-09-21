/** Monogram mark — a colored disc with an initial or short glyph.
 *  The shared building block for entity chips and monogram headings. */
export declare function Monogram({ children, color, className, }: {
    children: React.ReactNode;
    color?: string;
    className?: string;
}): import("react").JSX.Element;
/** Inline entity reference — a monogram + name in a soft field pill.
 *  Names a supplier, person, or record inside running text. Softer than a
 *  StatusPill (no dot, no state) and not a mono token (see Chip). */
export declare function EntityChip({ name, color, monogram, className, }: {
    name: string;
    color?: string;
    monogram?: React.ReactNode;
    className?: string;
}): import("react").JSX.Element;
