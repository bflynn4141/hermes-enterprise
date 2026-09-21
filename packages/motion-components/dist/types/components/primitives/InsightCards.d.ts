export type CompareSeries = {
    name: string;
    values: number[];
    sub: string;
    tone: "red" | "green";
    dot: string;
    color: string;
    tooltipColor: string;
};
export declare function CompareCard({ series }: {
    series?: CompareSeries[];
}): import("react").JSX.Element;
export type AnomalyData = {
    spend: number[];
    usage: number[];
};
export declare function AnomalyCard({ data: anomaly }: {
    data?: AnomalyData;
}): import("react").JSX.Element;
export type AllocationSegment = {
    name: string;
    label: string;
    pct: number;
    amount: string;
    cls: string;
    tone: string;
};
export declare function AllocationCard({ segments }: {
    segments?: AllocationSegment[];
}): import("react").JSX.Element;
export type InsightPage = {
    key: string;
    prose: React.ReactNode;
    Card: React.ComponentType;
    pill: string;
};
export type InsightCardsLabels = {
    /** carousel heading shown before the page count */
    title: string;
};
export default function InsightCards({ pages, labels, initialPage, onAction, onPageChange, }?: {
    variant?: string;
    pages?: InsightPage[];
    initialPage?: number;
    onAction?: (page: InsightPage) => void;
    onPageChange?: (page: InsightPage) => void;
    labels?: Partial<InsightCardsLabels>;
}): import("react").JSX.Element | null;
