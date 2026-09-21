export type TaskDetail = {
    label: string;
    meta: string;
};
export type TaskRow = {
    key: string;
    label: string;
    amount: string;
    status: "done" | "running" | "sequence" | "failed" | "blocked";
    step?: number;
    details: TaskDetail[];
};
export type TaskRowsLabels = {
    completed: string;
    failed: string;
    blocked: string;
};
export default function TaskRows({ variant, rows, labels, className, onToggleRow, onRetry, }: {
    variant?: string;
    rows?: TaskRow[];
    labels?: Partial<TaskRowsLabels>;
    className?: string;
    onToggleRow?: (key: string, open: boolean) => void;
    onRetry?: (key: string) => void;
}): import("react").JSX.Element;
