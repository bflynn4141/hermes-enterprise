import { type ReactNode } from "react";
export type SelectionText = {
    lead: string;
    original: string;
    rewrite: string;
};
export type SelectionAction = {
    id: string;
    icon: ReactNode;
    action?: string;
    busyLabel?: string;
};
export type SelectionActionSet = {
    primary: SelectionAction[];
    more: SelectionAction[];
};
export type SelectionActionsLabels = {
    keep: string;
    discard: string;
    placeholder: string;
};
export type SelectionActionsProps = {
    /** Accepted for gallery/registry parity; not used by this bar. */
    variant?: string;
    /** The passage shown above the bar. */
    text?: Partial<SelectionText>;
    /** The AI actions offered in the bar. */
    actions?: SelectionActionSet;
    /** Prominent copy strings. */
    labels?: Partial<SelectionActionsLabels>;
    /** Called with the action name whenever an edit is run. */
    onAction?: (action: string) => void;
    /** Supply generated text in an embedding app. The default is the supplied demo rewrite. */
    onRequestEdit?: (action: string, original: string) => Promise<string>;
    onKeep?: (text: string) => void;
    onDiscard?: () => void;
    explanation?: string;
};
export default function SelectionActions({ text: textProp, actions, labels, onAction, onRequestEdit, onKeep, onDiscard, explanation, }?: SelectionActionsProps): import("react").JSX.Element;
