"use client";

import { Fragment, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { groupCollection } from "@/lib/collection";

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  /** Custom cell renderer; defaults to `row[key]` when T has that property. */
  render?: (row: T) => ReactNode;
  /** Render the cell in JetBrains Mono (hosts, slugs, paths, keys). */
  mono?: boolean;
  className?: string;
  sortKey?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** When provided, rows get a chevron and can expand to this rendered content. */
  renderExpanded?: (row: T) => ReactNode;
  /** Optional group heading. Rows should already be sorted by the caller. */
  groupBy?: (row: T) => string;
  /** A custom row may contain its own stateful actions and progress detail. */
  renderRow?: (row: T) => ReactNode;
  sort?: { key: string; direction: "asc" | "desc"; onChange: (key: string) => void; };
  emptyMessage?: string;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  renderExpanded,
  groupBy,
  renderRow,
  sort,
  emptyMessage = "No entries.",
  className,
}: DataTableProps<T>) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandable = Boolean(renderExpanded);
  const colCount = columns.length + (expandable ? 1 : 0);
  const sections = groupCollection(rows, groupBy);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function defaultCell(row: T, key: string): ReactNode {
    const value = (row as Record<string, unknown>)[key];
    if (value === null || value === undefined) return "—";
    return String(value) as ReactNode;
  }

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {expandable ? (
              <th className="w-9 border-b border-neutral-200" aria-label="Expand" />
            ) : null}
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                aria-sort={col.sortKey && sort?.key === col.sortKey ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
                className={cn(
                  "whitespace-nowrap border-b border-neutral-200 px-4 py-2.5 text-left font-mono text-[10.5px] font-medium uppercase tracking-[0.18em] text-neutral-500",
                  col.className,
                )}
              >
                {col.sortKey && sort ? (
                  <button type="button" onClick={() => sort.onChange(col.sortKey!)} className="inline-flex items-center gap-1.5 rounded-sm text-inherit hover:text-cobalt-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400">
                    {col.header}
                    {sort.key !== col.sortKey ? <ArrowUpDown size={12} aria-hidden /> : sort.direction === "asc" ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />}
                  </button>
                ) : col.header}
              </th>
            ))}
          </tr>
        </thead>
        {rows.length === 0 ? (
          <tbody>
            <tr>
              <td
                colSpan={colCount}
                className="px-4 py-8 text-center text-[13px] text-neutral-500"
              >
                {emptyMessage}
              </td>
            </tr>
          </tbody>
        ) : (
            sections.map(([label, sectionRows]) => (
              <tbody key={label || "__all__"}>
                {groupBy ? (
                  <tr>
                    <th scope="rowgroup" colSpan={colCount} className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-left text-xs font-semibold text-neutral-600">
                      {label} <span className="ml-2 font-normal text-neutral-500">{sectionRows.length}</span>
                    </th>
                  </tr>
                ) : null}
                {sectionRows.map((row) => {
                  const key = rowKey(row);
                  const isOpen = expanded.has(key);
                  if (renderRow) return <Fragment key={key}>{renderRow(row)}</Fragment>;
                  return (
                    <Fragment key={key}>
                      <tr
                        onClick={
                          onRowClick
                            ? () => onRowClick(row)
                            : expandable
                              ? () => toggle(key)
                              : undefined
                        }
                        className={cn(
                          "transition-colors hover:bg-neutral-50",
                          (onRowClick || expandable) && "cursor-pointer",
                        )}
                      >
                        {expandable ? (
                          <td className="border-b border-neutral-100 py-3 pl-3 align-middle">
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-label={isOpen ? "Collapse row" : "Expand row"}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(key);
                              }}
                              className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-neutral-400 transition-colors hover:bg-cobalt-50 hover:text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
                            >
                              {isOpen ? (
                                <ChevronDown size={15} strokeWidth={1.75} />
                              ) : (
                                <ChevronRight size={15} strokeWidth={1.75} />
                              )}
                            </button>
                          </td>
                        ) : null}
                        {columns.map((col) => (
                          <td
                            key={col.key}
                            className={cn(
                              "border-b border-neutral-100 px-4 py-3 align-middle text-sm",
                              col.mono && "font-mono text-[13px]",
                              col.className,
                            )}
                          >
                            {col.render ? col.render(row) : defaultCell(row, col.key)}
                          </td>
                        ))}
                      </tr>
                      {expandable && isOpen ? (
                        <tr>
                          <td
                            colSpan={colCount}
                            className="border-b border-neutral-100 bg-neutral-50 px-4 py-4"
                          >
                            {renderExpanded?.(row)}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            ))
          )}
      </table>
    </div>
  );
}
