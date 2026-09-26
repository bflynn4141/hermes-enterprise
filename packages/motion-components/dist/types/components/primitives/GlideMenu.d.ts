import { type ReactNode } from "react";
type GlideMenuProps = {
    children: ReactNode;
    className?: string;
    highlightClassName?: string;
    rowSelector?: string;
};
/** A single hover layer that glides between interactive menu rows. */
export default function GlideMenu({ children, className, highlightClassName, rowSelector, }: GlideMenuProps): import("react").JSX.Element;
export {};
