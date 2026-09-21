/** Small progress ring with content in the center — the task-badge from the refs. */
export declare function ProgressRing({ progress, tone, children, size, }: {
    progress: number;
    tone?: "orange" | "green" | "red" | "accent";
    children?: React.ReactNode;
    size?: number;
}): import("react").JSX.Element;
