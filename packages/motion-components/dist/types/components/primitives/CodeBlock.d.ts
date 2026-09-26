export type CodePiece = {
    text: string;
    change?: "add" | "del";
};
export type DiffRow = {
    old: number | null;
    cur: number | null;
    type: "ctx" | "add" | "del";
    pieces: CodePiece[];
};
export type CodeBlockLabels = {
    copy: string;
    copied: string;
};
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
export default function CodeBlock({ variant, lines, code, diff, filename, labels, onCopy, onCopyError, }?: CodeBlockProps): import("react").JSX.Element;
