export type DiffRow = {
    key: string;
    id: string;
    dept: string;
    email: string;
    removed: boolean;
};
export type DiffSelection = {
    removed: DiffRow[];
    added: DiffRow[];
};
export default function DiffTable({ rows, addedRow, title, columns, onApply, onSelectionChange, }?: {
    rows?: DiffRow[];
    addedRow?: DiffRow;
    title?: string;
    columns?: [string, string, string];
    onApply?: (selection: DiffSelection) => void | Promise<void>;
    onSelectionChange?: (selection: DiffSelection) => void;
    variant?: string;
}): import("react").JSX.Element;
