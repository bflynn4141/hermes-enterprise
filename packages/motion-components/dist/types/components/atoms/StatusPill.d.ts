import { type VariantProps } from "class-variance-authority";
declare const statusPillVariants: (props?: ({
    tone?: "accent" | "green" | "orange" | "red" | "neutral" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
type Tone = NonNullable<VariantProps<typeof statusPillVariants>["tone"]>;
export declare function StatusPill({ tone, children, dot, className, }: {
    tone?: Tone;
    children: React.ReactNode;
    dot?: boolean;
    className?: string;
}): import("react").JSX.Element;
export {};
