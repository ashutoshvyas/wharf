"use client";

/**
 * Audit log screen (design §5.10 + prototype viewAudit()).
 *
 * DataTable: mono timestamp · user · action Badge (danger tint for anything
 * matching /remove|delete/) · target (linked into its module when the type is
 * routable). Row expansion prints the metadata as formatted mono JSON.
 *
 * READ-ONLY BY DESIGN: there is no edit or delete affordance anywhere on this
 * screen, and none can be added — `audit_log` rejects UPDATE and DELETE at
 * the database level (insert-only trigger). Every role can read it
 * (`audit.read` = all roles), so nothing here is role-gated.
 *
 * Paging is cursor-based ("Load more"), never offset-based: new rows land at
 * the head constantly, and an offset would duplicate or skip entries between
 * pages.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionLabel } from "@/components/ui/section-label";
import {
  ACTION_PREFIXES,
  EMPTY_FILTERS,
  fetchAuditPage,
  formatMetadata,
  formatTimestamp,
  isDestructiveAction,
  type AuditEntryDto,
  type AuditFilterValues,
} from "./api";

const FIELD_CLASSES =
  "h-9 rounded-[6px] border border-neutral-200 bg-white px-2.5 text-[13px] text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none";

/** Target types that have a screen to jump to. */
const TARGET_HREF: Record<string, (id: string | null) => string | null> = {
  server: (id) => (id ? `/servers/${id}` : "/servers"),
  website: () => "/websites",
  db_instance: () => "/databases",
  user: () => "/users",
};

/** Debounce so typing in the user field does not fire a request per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function AuditView() {
  const [draft, setDraft] = useState<AuditFilterValues>(EMPTY_FILTERS);
  const filters = useDebounced(draft, 300);

  const query = useInfiniteQuery({
    queryKey: ["audit", filters],
    queryFn: ({ pageParam }) => fetchAuditPage(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
  );

  const filtered =
    draft.actionPrefix !== "" ||
    draft.userEmail !== "" ||
    draft.from !== "" ||
    draft.to !== "";

  function set<K extends keyof AuditFilterValues>(
    key: K,
    value: AuditFilterValues[K],
  ) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const columns: DataTableColumn<AuditEntryDto>[] = [
    {
      key: "createdAt",
      header: "Timestamp",
      mono: true,
      className: "whitespace-nowrap text-neutral-500",
      render: (e) => formatTimestamp(e.createdAt),
    },
    {
      key: "userEmail",
      header: "User",
      render: (e) =>
        e.userEmail ?? <span className="text-neutral-400">system</span>,
    },
    {
      key: "action",
      header: "Action",
      render: (e) => (
        <Badge
          variant={isDestructiveAction(e.action) ? "danger" : "neutral"}
          className="font-mono text-[11px]"
        >
          {e.action}
        </Badge>
      ),
    },
    {
      key: "target",
      header: "Target",
      mono: true,
      render: (e) => {
        const href = TARGET_HREF[e.targetType]?.(e.targetId) ?? null;
        const label = e.targetId ?? e.targetType;
        return (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-[11px] uppercase tracking-[0.08em] text-neutral-400">
              {e.targetType}
            </span>
            {href ? (
              <Link
                href={href}
                onClick={(ev) => ev.stopPropagation()}
                className="truncate text-cobalt-600 hover:underline"
                title={label}
              >
                {label}
              </Link>
            ) : (
              <span className="truncate text-neutral-600" title={label}>
                {label}
              </span>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <div className="mb-5">
        <SectionLabel>Trace</SectionLabel>
        <h2 className="mt-1 text-[26px] font-bold tracking-tight">Audit log</h2>
        <p className="mt-0.5 text-[13px] text-neutral-500">
          Insert-only. Every provision, removal, terminal session and secret
          reveal — who, what, when.
        </p>
      </div>

      {/* Filter bar (design §5.10: user, action type, date range). */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-action" className="label-track text-neutral-500">
            Action
          </label>
          <select
            id="audit-action"
            value={draft.actionPrefix}
            onChange={(e) => set("actionPrefix", e.target.value)}
            className={`${FIELD_CLASSES} w-[180px]`}
          >
            <option value="">All actions</option>
            {ACTION_PREFIXES.map((prefix) => (
              <option key={prefix} value={prefix}>
                {prefix}*
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-user" className="label-track text-neutral-500">
            User
          </label>
          <input
            id="audit-user"
            type="search"
            placeholder="email contains…"
            value={draft.userEmail}
            onChange={(e) => set("userEmail", e.target.value)}
            className={`${FIELD_CLASSES} w-[220px]`}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-from" className="label-track text-neutral-500">
            From
          </label>
          <input
            id="audit-from"
            type="date"
            value={draft.from}
            onChange={(e) => set("from", e.target.value)}
            className={`${FIELD_CLASSES} w-[160px]`}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-to" className="label-track text-neutral-500">
            To
          </label>
          <input
            id="audit-to"
            type="date"
            value={draft.to}
            onChange={(e) => set("to", e.target.value)}
            className={`${FIELD_CLASSES} w-[160px]`}
          />
        </div>

        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft(EMPTY_FILTERS)}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {query.isError ? (
        <Alert variant="danger" title="Could not load the audit log">
          {(query.error as Error).message}
        </Alert>
      ) : (
        <Card>
          {query.isPending ? (
            <p className="px-5 py-10 text-center text-[13px] text-neutral-500">
              Loading entries…
            </p>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              message={
                filtered
                  ? "No entries match these filters."
                  : "No audit entries yet — actions you take will show up here."
              }
            />
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(e) => e.id}
                renderExpanded={(e) => (
                  <pre className="overflow-x-auto font-mono text-[12px] whitespace-pre-wrap text-neutral-600">
                    {formatMetadata(e.metadata)}
                  </pre>
                )}
              />
              {query.hasNextPage ? (
                <div className="flex justify-center border-t border-neutral-100 px-4 py-3.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                  >
                    {query.isFetchingNextPage ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
