import { type ButtonVariant } from "../atoms/Button";
export type RecommendationOption = {
    key: string;
    body: React.ReactNode;
    short: string;
    signal: number;
    tone: string;
    label: string;
    cta: string;
    ctaVariant: ButtonVariant;
};
export type RecommendationLabels = {
    title: string;
    alternatives: string;
    otherOptions: string;
    accepted: string;
};
export default function RecommendationCard({ options, labels, onConfirm, onSelect, }?: {
    options?: RecommendationOption[];
    /** Resolves when the destination or draft is ready; rejection keeps the card actionable. */
    onConfirm?: (option: RecommendationOption) => void | Promise<void>;
    onSelect?: (option: RecommendationOption) => void;
    labels?: Partial<RecommendationLabels>;
    variant?: string;
}): import("react").JSX.Element | null;
