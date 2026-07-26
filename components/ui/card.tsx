import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds hover lift + shadow-md (clickable / linked cards). */
  hoverable?: boolean;
  /** Cobalt glow shadow — reserved for the single active/emphasized element. */
  glow?: boolean;
}

export function Card({ hoverable, glow, className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-[12px] border border-neutral-200 bg-white",
        glow ? "shadow-glow" : "shadow-sm",
        hoverable &&
          "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md",
        className,
      )}
      {...props}
    />
  );
}
