import { type ReactNode } from 'react';
/** OS reduced motion is always honored; the provider can also request less motion. */
export declare function useReducedMotion(): boolean;
export declare function HermesMotionProvider({ reducedMotion, children }: {
    reducedMotion?: boolean;
    children: ReactNode;
}): import("react").JSX.Element;
