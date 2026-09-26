export type ApprovalQuestion = {
    q: string;
    type: "radio" | "check";
    options: string[];
};
export type ApprovalLabels = {
    skip: string;
    continue: string;
    send: string;
    customPlaceholder: string;
    sentMessage: string;
};
export default function ApprovalCard({ questions, labels, onSubmitted, onAnswerChange, onReset, resettable, }?: {
    questions?: ApprovalQuestion[];
    labels?: Partial<ApprovalLabels>;
    onSubmitted?: (answers: Record<number, number[]>, customAnswers: Record<number, string>) => void;
    onAnswerChange?: (questionIndex: number, answer: number[]) => void;
    onReset?: () => void;
    resettable?: boolean;
    variant?: string;
}): import("react").JSX.Element | null;
