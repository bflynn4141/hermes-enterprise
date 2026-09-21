export type PromptSource = {
    key: string;
    name: string;
    desc: string;
    glyph?: string;
    brand?: string;
    attach?: boolean;
    connect?: boolean;
};
export type PromptCommand = {
    key: string;
    name: string;
    desc: string;
};
export type PromptModel = {
    key: string;
    name: string;
    tag: string;
};
export type PromptSubmission = {
    text: string;
    attachments: string[];
    model: PromptModel;
    runtime: "Cloud" | "Local";
};
export default function PromptBar({ variant, demo, tall, placeholder, onSend, sources, commands, models, initialModel, runtime, onRuntimeChange, onModelChange, onAttach, onDictate, }: {
    variant?: string;
    /** the self-running walkthrough; turn off when embedding in a real surface */
    demo?: boolean;
    /** hero sizing: a multi-line input with controls on their own row */
    tall?: boolean;
    placeholder?: string;
    onSend?: (text: string, submission: PromptSubmission) => void;
    sources?: PromptSource[];
    commands?: PromptCommand[];
    models?: PromptModel[];
    initialModel?: string;
    runtime?: "Cloud" | "Local";
    onRuntimeChange?: (runtime: "Cloud" | "Local") => void;
    onModelChange?: (model: PromptModel) => void;
    onAttach?: (files: File[]) => void;
    /** Provide real dictation in an embedding app. Without it, only the labeled demo is available. */
    onDictate?: () => Promise<string>;
}): import("react").JSX.Element;
