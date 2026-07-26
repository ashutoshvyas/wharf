"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional coral attention dot (e.g. a tab with an error state). */
  attention?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  /** Controlled active tab id. */
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

/** Underline-style controlled tabs — active: cobalt-600 text + 2px cobalt border. */
export function Tabs({ tabs, value, onChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      className={cn("flex gap-1 border-b border-neutral-200", className)}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cobalt-400",
              active
                ? "border-cobalt-500 text-cobalt-600"
                : "border-transparent text-neutral-500 hover:text-ink",
            )}
          >
            {tab.label}
            {tab.attention ? (
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-coral-500"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
