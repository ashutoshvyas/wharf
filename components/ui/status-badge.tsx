import { cn } from "@/lib/cn";

/** Instance statuses + server bootstrap states (design §4.2). */
export type Status =
  | "running"
  | "provisioning"
  | "stopped"
  | "error"
  | "removing"
  | "restoring"
  | "working"
  | "bootstrapped"
  | "not_bootstrapped"
  | "unreachable";

interface StatusSpec {
  label: string;
  pill: string;
  dot: string;
  pulse?: boolean;
}

const SPECS: Record<Status, StatusSpec> = {
  running: {
    label: "running",
    pill: "bg-tint-success text-[#207a51]",
    dot: "bg-success",
  },
  provisioning: {
    label: "provisioning",
    pill: "bg-coral-50 text-coral-700",
    dot: "bg-coral-500",
    pulse: true,
  },
  stopped: {
    label: "stopped",
    pill: "bg-tint-warning text-[#9a6b1a]",
    dot: "bg-warning",
  },
  error: {
    label: "error",
    pill: "bg-tint-danger text-danger",
    dot: "bg-danger",
  },
  removing: {
    label: "removing",
    pill: "bg-tint-danger text-danger",
    dot: "bg-danger",
    pulse: true,
  },
  restoring: {
    label: "restoring",
    pill: "bg-coral-50 text-coral-700",
    dot: "bg-coral-500",
    pulse: true,
  },
  working: {
    label: "working…",
    pill: "bg-cobalt-50 text-cobalt-700",
    dot: "bg-cobalt-400",
    pulse: true,
  },
  bootstrapped: {
    label: "bootstrapped",
    pill: "bg-tint-success text-[#207a51]",
    dot: "bg-success",
  },
  not_bootstrapped: {
    label: "not bootstrapped",
    pill: "bg-neutral-100 text-neutral-600",
    dot: "bg-neutral-400",
  },
  unreachable: {
    label: "unreachable",
    pill: "bg-tint-danger text-danger",
    dot: "bg-danger",
  },
};

export interface StatusBadgeProps {
  status: Status;
  /** Override the default label text (label is always rendered — a11y). */
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const spec = SPECS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[7px] whitespace-nowrap rounded-full px-3 py-[3px] font-mono text-[10.5px] font-medium uppercase tracking-[0.14em]",
        spec.pill,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-[7px] w-[7px] rounded-[2px]",
          spec.dot,
          // motion-safe: reduced-motion kill-switch in globals.css also covers this
          spec.pulse && "animate-spark-fast",
        )}
      />
      {label ?? spec.label}
    </span>
  );
}
