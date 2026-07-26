import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SectionLabelProps {
  children: ReactNode;
  className?: string;
}

/** Coral tracked-mono section label with a 24px dash prefix. */
export function SectionLabel({ children, className }: SectionLabelProps) {
  return (
    <span
      className={cn(
        "label-track inline-flex items-center gap-2 text-coral-600",
        className,
      )}
    >
      <span aria-hidden className="h-px w-6 bg-coral-400" />
      {children}
    </span>
  );
}
