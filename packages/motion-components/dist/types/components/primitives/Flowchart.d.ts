export type StepNode = {
    id: string;
    row: number;
    x: number;
    w: number;
    kind?: {
        label: string;
        hue: string;
    };
    hue?: string;
    title?: string;
    caption?: string;
    condition?: boolean;
};
export declare const PARTNER_STEPS: StepNode[];
export type FlowEdge = {
    from: string;
    to: string;
    loop?: boolean;
};
export type FlowConditions = Record<string, string>;
export default function Flowchart({ steps, edges, onSelect, onMove, onConditionsChange }?: {
    steps?: StepNode[];
    edges?: FlowEdge[];
    variant?: string;
    onSelect?: (step: StepNode | null) => void;
    onMove?: (id: string, offset: {
        dx: number;
        dy: number;
    }) => void;
    onConditionsChange?: (values: FlowConditions) => void;
}): import("react").JSX.Element | null;
