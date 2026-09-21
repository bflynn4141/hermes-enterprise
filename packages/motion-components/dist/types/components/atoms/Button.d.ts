import { ButtonHTMLAttributes } from "react";
import { type VariantProps } from "class-variance-authority";
export declare const buttonVariants: (props?: ({
    variant?: "primary" | "secondary" | "ghost" | "accent" | "success" | "quiet" | null | undefined;
    size?: "xs" | "sm" | "md" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export declare function Button({ variant, size, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>): import("react").JSX.Element;
