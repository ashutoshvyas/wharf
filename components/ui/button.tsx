import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import type { LinkProps } from "next/link";
import { cn } from "@/lib/cn";

export type ButtonVariant =
  | "primary"
  | "accent"
  | "secondary"
  | "ghost"
  | "onDark"
  | "danger";

export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-[12px] font-semibold whitespace-nowrap transition-all duration-200 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 focus-visible:ring-offset-2 " +
  "disabled:pointer-events-none disabled:opacity-50 active:translate-y-0";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-cobalt-500 text-white shadow-[0_8px_24px_-8px_rgba(43,84,199,0.6)] hover:bg-cobalt-600 hover:-translate-y-0.5",
  accent:
    "bg-coral-500 text-white shadow-[0_8px_24px_-8px_rgba(236,107,69,0.6)] hover:bg-coral-600 hover:-translate-y-0.5",
  secondary:
    "border border-neutral-200 bg-white text-ink hover:border-cobalt-300 hover:text-cobalt-600 hover:-translate-y-0.5",
  ghost: "bg-transparent text-cobalt-600 hover:bg-cobalt-50",
  onDark:
    "border border-white/20 bg-white/10 text-white hover:bg-white/20 focus-visible:ring-offset-0",
  danger:
    "bg-[#d8493c] text-white shadow-[0_8px_24px_-8px_rgba(216,73,60,0.55)] hover:bg-[#c03e33] hover:-translate-y-0.5",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-[13px]",
  md: "h-11 px-5 text-sm",
  lg: "h-13 px-6 text-[15px]",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, className)}
      {...props}
    />
  );
}

export interface ButtonLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps | "className">,
    LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonLinkProps) {
  return <Link className={buttonClasses(variant, size, className)} {...props} />;
}
