export type ChatMessage = {
    label: string;
    sub: string;
    time: string;
    body: string;
    /** Optional structured findings, rendered as readable rows. */
    details?: {
        label: string;
        value: string;
    }[];
};
export type ChatComposerLabels = {
    initialPrompt: string;
    placeholder: string;
};
export default function ChatComposer({ messages, suggestions, labels, onSend, onTabChange, onAction, sessionMessages, sessionPrompts, autoplay, }?: {
    variant?: string;
    /** Fixture replies; connect onSend to an application to provide real replies. */
    messages?: ChatMessage[];
    suggestions?: string[];
    labels?: Partial<ChatComposerLabels>;
    onSend?: (text: string) => void;
    onTabChange?: (session: string) => void;
    onAction?: (action: "new" | "copy" | "collective" | "stop") => void;
    sessionMessages?: Record<string, ChatMessage[]>;
    sessionPrompts?: Record<string, string>;
    /** Replay the initial fixture; keep off for real conversation surfaces. */
    autoplay?: boolean;
}): import("react").JSX.Element;
