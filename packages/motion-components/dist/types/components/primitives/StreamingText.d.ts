export type StreamingToken = {
    text: string;
    cite?: boolean;
};
export type StreamingSource = {
    name: string;
    domain: string;
    href: string;
    image: string;
};
export type StreamingLabels = {
    /** label on the collapsed sources toggle */
    sources: string;
    /** heading above the follow-up prompts */
    followUps: string;
};
export default function StreamingText({ content, sources, followUps, labels, loop, fill, onDone, onFollowUp, onAction, }?: {
    variant?: string;
    /** the streamed tokens; `cite` tokens render an inline source chip */
    content?: StreamingToken[];
    /** cited sources shown in the chip, avatar stack, and expanded list */
    sources?: StreamingSource[];
    /** follow-up prompt suggestions shown once the stream completes */
    followUps?: string[];
    /** prominent copy strings */
    labels?: Partial<StreamingLabels>;
    /** restart the stream after a hold; turn off when embedding in a real thread */
    loop?: boolean;
    /** fill the parent width instead of the gallery's fixed measure */
    fill?: boolean;
    onDone?: () => void;
    /** fired when a follow-up prompt is chosen */
    onFollowUp?: (text: string, index: number) => void;
    onAction?: (action: "copy" | "retry" | "helpful" | "collective") => void;
}): import("react").JSX.Element;
