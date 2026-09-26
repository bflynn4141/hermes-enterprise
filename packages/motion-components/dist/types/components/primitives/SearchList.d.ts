export type SearchItem = string;
export type SearchListLabels = {
    placeholder: string;
    ariaLabel: string;
    emptyTitle: string;
    emptyHint: string;
};
export default function SearchList({ items, labels, onSelect, }?: {
    items?: SearchItem[];
    labels?: SearchListLabels;
    onSelect?: (item: SearchItem) => void;
    variant?: string;
}): import("react").JSX.Element;
