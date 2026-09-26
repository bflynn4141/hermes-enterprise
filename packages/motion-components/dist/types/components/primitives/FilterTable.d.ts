export type Status = "todo" | "progress" | "done";
export type TableRow = {
    task: string;
    date: string;
    status: Status;
    owner: string;
};
export type FilterTableLabels = {
    columns: {
        task: string;
        date: string;
        status: string;
        owner: string;
    };
};
export declare const PROGRAM_TASKS: TableRow[];
export default function FilterTable({ rows, labels, initialFilter, onFilterChange, onOpenRow, }?: {
    rows?: TableRow[];
    initialFilter?: "all" | Status;
    onFilterChange?: (filter: "all" | Status) => void;
    onOpenRow?: (row: TableRow) => void;
    labels?: FilterTableLabels;
    variant?: string;
}): import("react").JSX.Element;
