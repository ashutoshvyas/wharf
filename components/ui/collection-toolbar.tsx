"use client";

import { ArrowDownAZ, ArrowUpAZ, Grid2X2, List } from "lucide-react";
import { cn } from "@/lib/cn";

export type CollectionView = "cards" | "list";
export type CollectionDirection = "asc" | "desc";

export interface CollectionOption {
  value: string;
  label: string;
}

export function CollectionToolbar({
  count,
  view,
  onViewChange,
  sort,
  sortOptions,
  onSortChange,
  direction,
  onDirectionChange,
  group,
  groupOptions,
  onGroupChange,
}: {
  count: number;
  view: CollectionView;
  onViewChange: (view: CollectionView) => void;
  sort: string;
  sortOptions: CollectionOption[];
  onSortChange: (sort: string) => void;
  direction: CollectionDirection;
  onDirectionChange: (direction: CollectionDirection) => void;
  group: string;
  groupOptions: CollectionOption[];
  onGroupChange: (group: string) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-neutral-200 bg-white px-3 py-2.5 shadow-sm">
      <span className="text-xs text-neutral-500">
        {count} {count === 1 ? "item" : "items"}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs font-medium text-neutral-500">
          <span>Sort</span>
          <select
            aria-label="Sort collection"
            value={sort}
            onChange={(event) => onSortChange(event.target.value)}
            className="h-11 rounded-md border border-neutral-300 bg-white px-2.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 sm:h-9"
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-label={direction === "asc" ? "Switch to descending order" : "Switch to ascending order"}
          title={direction === "asc" ? "Ascending" : "Descending"}
          onClick={() => onDirectionChange(direction === "asc" ? "desc" : "asc")}
          className="inline-flex h-11 items-center justify-center gap-1.5 rounded-md border border-neutral-300 px-2.5 text-xs text-neutral-600 transition-colors hover:bg-cobalt-50 hover:text-cobalt-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 sm:h-9"
        >
          {direction === "asc" ? <ArrowDownAZ size={16} aria-hidden /> : <ArrowUpAZ size={16} aria-hidden />}
          {direction === "asc" ? "Ascending" : "Descending"}
        </button>
        <label className="flex items-center gap-2 text-xs font-medium text-neutral-500">
          <span>Group</span>
          <select
            aria-label="Group collection"
            value={group}
            onChange={(event) => onGroupChange(event.target.value)}
            className="h-11 rounded-md border border-neutral-300 bg-white px-2.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 sm:h-9"
          >
            {groupOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <div className="flex rounded-md border border-neutral-300 bg-neutral-50 p-0.5" role="group" aria-label="View">
          {(["cards", "list"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-label={option === "cards" ? "Card view" : "List view"}
              aria-pressed={view === option}
              onClick={() => onViewChange(option)}
              className={cn(
                "inline-flex h-11 items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400 sm:h-8",
                view === option ? "bg-white text-cobalt-700 shadow-sm" : "text-neutral-500 hover:text-ink",
              )}
            >
              {option === "cards" ? <Grid2X2 size={16} aria-hidden /> : <List size={17} aria-hidden />}
              {option === "cards" ? "Cards" : "List"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
