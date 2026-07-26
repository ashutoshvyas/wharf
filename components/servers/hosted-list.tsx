"use client";

/**
 * HostedList — the per-server "everything hosted here" view
 * (design §5.4 Hosted tab): websites + db instances merged into one
 * type-iconed DataTable. Consumed by the server-detail page workstream:
 *
 *   <HostedList serverId={server.id} />
 *
 * GET /api/db-instances does not exist until Milestone 4 — a 404 simply
 * yields an empty instances list.
 */
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Database, Globe } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { StatusBadge, type Status } from "@/components/ui/status-badge";
import {
  fetchDbInstanceOptions,
  fetchWebsites,
} from "@/components/websites/api";

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "provisioning",
  "stopped",
  "error",
  "removing",
]);

interface HostedRow {
  key: string;
  kind: "website" | "database";
  name: string;
  path: string;
  status: Status | null;
  href: "/websites" | "/databases";
}

export function HostedList({ serverId }: { serverId: string }) {
  const router = useRouter();

  const websites = useQuery({
    queryKey: ["websites", { serverId }],
    queryFn: () => fetchWebsites(serverId),
  });
  const instances = useQuery({
    queryKey: ["db-instances", { serverId }],
    queryFn: () => fetchDbInstanceOptions(serverId),
    retry: false,
  });

  const rows: HostedRow[] = [
    ...(websites.data ?? []).map(
      (w): HostedRow => ({
        key: `website-${w.id}`,
        kind: "website",
        name: w.domain,
        path: w.path,
        status: null,
        href: "/websites",
      }),
    ),
    ...(instances.data?.instances ?? []).map(
      (i): HostedRow => ({
        key: `database-${i.id}`,
        kind: "database",
        name: i.name,
        path: i.remotePath ?? i.path ?? "",
        status:
          i.status && KNOWN_STATUSES.has(i.status) ? (i.status as Status) : null,
        href: "/databases",
      }),
    ),
  ];

  const columns: DataTableColumn<HostedRow>[] = [
    {
      key: "icon",
      header: "",
      className: "w-9",
      render: (row) =>
        row.kind === "website" ? (
          <Globe size={15} strokeWidth={1.75} className="text-neutral-400" aria-label="Website" />
        ) : (
          <Database size={15} strokeWidth={1.75} className="text-neutral-400" aria-label="Database" />
        ),
    },
    { key: "name", header: "Name", mono: true },
    {
      key: "kind",
      header: "Type",
      render: (row) => (row.kind === "website" ? "Website" : "Database"),
    },
    {
      key: "path",
      header: "Path",
      mono: true,
      className: "max-w-[240px]",
      render: (row) => (
        <span className="block truncate text-neutral-500" title={row.path}>
          {row.path || "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) =>
        row.status ? (
          <StatusBadge status={row.status} />
        ) : (
          <span className="text-neutral-400">—</span>
        ),
    },
  ];

  if (websites.isError) {
    return (
      <Alert variant="danger" title="Could not load hosted items">
        {websites.error.message}
      </Alert>
    );
  }

  if (websites.isPending || instances.isPending) {
    return (
      <p className="px-4 py-8 text-center text-[13px] text-neutral-500">
        Loading hosted items…
      </p>
    );
  }

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
      onRowClick={(row) => router.push(row.href)}
      emptyMessage="Nothing hosted on this server yet."
    />
  );
}
