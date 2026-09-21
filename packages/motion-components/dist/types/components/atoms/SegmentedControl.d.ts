/** Segmented control — equal-width segments, sliding thumb. */
export declare function SegmentedControl<T extends string>({ options, value, onChange, className, }: {
    options: readonly T[];
    value: T;
    onChange: (v: T) => void;
    className?: string;
}): import("react").JSX.Element;
