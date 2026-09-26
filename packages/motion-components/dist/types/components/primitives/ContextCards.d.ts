export type ContextChunk = {
    title: string;
    chars: string;
    body: string;
    source: string;
    badge: string;
    tone: string;
};
export type ContextCardsLabels = {
    header: string;
    count: string;
};
export declare const PARTNER_CONTEXT: ContextChunk[];
export default function ContextCards({ chunks, labels, className, onOpenSource, }?: {
    /** Accepted for gallery/registry parity; ContextCards has no visual variants. */
    variant?: string;
    chunks?: ContextChunk[];
    onOpenSource?: (chunk: ContextChunk) => void;
    labels?: Partial<ContextCardsLabels>;
    className?: string;
}): import("react").JSX.Element;
