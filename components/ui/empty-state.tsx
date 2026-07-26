import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  icon: LucideIcon;
  /** One sentence, e.g. "No servers yet — register your first server." */
  message: ReactNode;
  /** Optional action button. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  message,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-5 py-14 text-center text-neutral-500",
        className,
      )}
    >
      <Icon size={32} strokeWidth={1.75} className="text-neutral-300" aria-hidden />
      <p className="text-sm">{message}</p>
      {action}
    </div>
  );
}
