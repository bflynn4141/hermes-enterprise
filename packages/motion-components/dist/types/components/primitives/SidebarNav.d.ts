import { type ReactNode } from "react";
export type SidebarRecent = {
    id: string;
    label: string;
    prompt?: string;
};
export type SidebarNavProps = {
    workspace?: {
        key: string;
        name: string;
        monogram: string;
    };
    navItems?: {
        key: string;
        label: string;
        icon: ReactNode;
        count?: string;
    }[];
    onWorkspaceAction?: (action: string) => void;
    activeTitle?: string | null;
    className?: string;
    fill?: boolean;
    onNewChat?: () => void;
    onPick?: (id: string, label: string, prompt?: string) => void;
    /** controlled primary-nav selection (e.g. "home" | "invite") */
    activeNav?: string;
    onNavigate?: (key: string) => void;
    /** Footer identity / settings entry. */
    footerLabel?: string;
    footerIcon?: ReactNode;
    onFooterClick?: () => void;
    recents?: SidebarRecent[];
    variant?: string;
};
export default function SidebarNav({ activeTitle, className, fill, onNewChat, onPick, activeNav, onNavigate, footerLabel, footerIcon, onFooterClick, recents, workspace, navItems, onWorkspaceAction, }?: SidebarNavProps): import("react").JSX.Element;
