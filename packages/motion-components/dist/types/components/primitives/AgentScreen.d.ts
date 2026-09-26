import { type ReactNode } from 'react';
export declare function PartnerWorkspacePreview(): import("react").JSX.Element;
export type AgentScreenProps = {
    agentName?: string;
    streamSrc?: string;
    variant?: string;
    children?: ReactNode;
    onCaptureStart?: () => void;
    onCaptureEnd?: (seconds: number) => void;
    onOpenChange?: (open: boolean) => void;
};
/** Screen interaction is local unless supplied a stream and capture callbacks. No browser/microphone permission requested. */
export default function AgentScreen({ agentName, streamSrc, variant, children, onCaptureStart, onCaptureEnd, onOpenChange }?: AgentScreenProps): import("react").JSX.Element;
