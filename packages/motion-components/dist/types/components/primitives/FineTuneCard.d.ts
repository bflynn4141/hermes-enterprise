export type FineTuneField = {
    key: string;
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    suffix?: string;
};
export type FineTuneCardLabels = {
    title: string;
    layout: string;
    type: string;
    placeholder: string;
    adjust: string;
    edited: string;
};
export type FineTuneState = {
    segment: number;
    values: Record<string, number>;
    type: string;
};
export type FineTuneCardProps = {
    /** Accepted for gallery/registry parity; not used by this card. */
    variant?: string;
    /** The scrub-able properties shown in the layout grid (rendered in pairs). */
    fields?: FineTuneField[];
    /** Options offered in the Type menu. */
    options?: string[];
    /** Prominent copy strings. */
    labels?: Partial<FineTuneCardLabels>;
    /** Called with the full editable state whenever the user edits it. */
    onChange?: (state: FineTuneState) => void;
};
export default function FineTuneCard({ fields, options, labels, onChange, }?: FineTuneCardProps): import("react").JSX.Element;
