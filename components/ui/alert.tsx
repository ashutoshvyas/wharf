import type { ReactNode } from "react";
import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";

export type AlertVariant = "info" | "success" | "warning" | "danger";

const VARIANTS: Record<AlertVariant, string> = {
  info: "bg-tint-info border-info text-cobalt-800",
  success: "bg-[rgba(46,158,107,0.08)] border-success text-[#1d6b46]",
  warning: "bg-[rgba(231,166,60,0.09)] border-warning text-[#7a5312]",
  danger: "bg-[rgba(216,73,60,0.07)] border-danger text-[#8f2f26]",
};

const DEFAULT_ICON: Record<AlertVariant, ReactNode> = {
  info: <Info size={17} strokeWidth={1.75} />,
  success: <CircleCheck size={17} strokeWidth={1.75} />,
  warning: <TriangleAlert size={17} strokeWidth={1.75} />,
  danger: <TriangleAlert size={17} strokeWidth={1.75} />,
};

export interface AlertProps {
  variant?: AlertVariant;
  title?: ReactNode;
  /** Custom icon slot; pass `null` to render no icon. */
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Alert({
  variant = "info",
  title,
  icon,
  children,
  className,
}: AlertProps) {
  const resolvedIcon = icon === undefined ? DEFAULT_ICON[variant] : icon;
  return (
    <div
      role={variant === "danger" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-[6px] border-l-[3px] px-4 py-[13px] text-[13.5px]",
        VARIANTS[variant],
        className,
      )}
    >
      {resolvedIcon ? <span className="mt-px shrink-0">{resolvedIcon}</span> : null}
      <div className="min-w-0">
        {title ? <b className="mb-px block font-semibold">{title}</b> : null}
        {children}
      </div>
    </div>
  );
}
