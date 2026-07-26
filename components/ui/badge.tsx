import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type BadgeVariant = "cobalt" | "coral" | "neutral" | "onDark" | "danger";

const VARIANTS: Record<BadgeVariant, string> = {
  cobalt: "border-cobalt-100 bg-cobalt-50 text-cobalt-700",
  coral: "border-coral-100 bg-coral-50 text-coral-700",
  neutral: "border-neutral-200 bg-neutral-100 text-neutral-600",
  onDark: "border-white/15 bg-white/10 text-white",
  danger: "border-[rgba(216,73,60,0.2)] bg-[rgba(216,73,60,0.08)] text-danger",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ variant = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-xs font-medium",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
