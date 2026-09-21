export type Strength = "strong" | "weak" | "veryweak" | "none";
export type RecordRow = {
    id: string;
    name: string;
    tags: string[];
    last: string;
    strength: Strength;
    website?: string;
    reviewGap?: string;
};
export declare const PARTNER_RECORDS: RecordRow[];
export type CalculationRequest = {
    column: string;
    rows: RecordRow[];
    prompt: string;
    inputs: string[];
    model: string;
    grounding: boolean;
    type: string;
    required: boolean;
    allowEmpty: boolean;
    showSourceCoverage: boolean;
};
export default function RecordsTable({ rows, fill, onSelectionChange, onOpenRow, onCalculate }?: {
    rows?: RecordRow[];
    fill?: boolean;
    variant?: string;
    onSelectionChange?: (ids: string[]) => void;
    onOpenRow?: (row: RecordRow) => void;
    onCalculate?: (request: CalculationRequest) => Promise<Record<string, string>>;
}): import("react").JSX.Element;
