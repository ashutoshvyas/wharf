"use client";

/**
 * Websites screen (, design §5.5 + prototype viewWebsites()).
 *
 * Card/list views of every tracked domain with expansion for the credential
 * block, an Add/Edit modal, and a danger ConfirmModal for delete. Write
 * actions are HIDDEN (never disabled) for roles without websites.write
 * (design §6).
 */
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ellipsis,
  ExternalLink,
  Globe,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { groupCollection, sortCollection } from "@/lib/collection";
import { CollectionToolbar } from "@/components/ui/collection-toolbar";
import { useCollectionPreferences } from "@/components/ui/use-collection-preferences";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { DropdownMenu } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionLabel } from "@/components/ui/section-label";
import { useToast } from "@/components/ui/toast";
import { deleteWebsite, fetchWebsites, type WebsiteDto } from "./api";
import { CredentialBlock } from "./credential-block";
import { WebsiteFormModal } from "./website-form-modal";

const SORT_OPTIONS = [
  { value: "domain", label: "Domain" }, { value: "host", label: "Server IP / host" },
  { value: "server", label: "Server name" }, { value: "database", label: "Database" },
  { value: "created", label: "Created date" },
];
const GROUP_OPTIONS = [
  { value: "none", label: "No grouping" }, { value: "host", label: "Server IP / host" },
];
export function WebsitesView({ role }: { role: Role; }) {
  const writable = can(role, "websites.write");
  const canReveal = can(role, "secrets.reveal");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [modalOpen, setModalOpen] = useState(false);
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<WebsiteDto | null>(null);
  const [deleting, setDeleting] = useState<WebsiteDto | null>(null);

  const websites = useQuery({
    queryKey: ["websites"],
    queryFn: () => fetchWebsites(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteWebsite(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["websites"] });
      toast({ message: `${deleting?.domain ?? "Website"} deleted`, variant: "success" });
      setDeleting(null);
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", message: err.message, variant: "danger" });
    },
  });

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(website: WebsiteDto) {
    setEditing(website);
    setModalOpen(true);
  }

  const columns: DataTableColumn<WebsiteDto>[] = [
    {
      key: "domain",
      header: "Domain",
      sortKey: "domain",
      mono: true,
      render: (w) => (
        <a
          href={`https://${w.domain}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 text-cobalt-600 hover:underline"
        >
          {w.domain}
          <ExternalLink size={13} strokeWidth={1.75} aria-hidden />
        </a>
      ),
    },
    {
      key: "server",
      header: "Server",
      sortKey: "host",
      render: (w) =>
        w.server ? (
          <Link
            href={`/servers/${w.serverId}`}
            onClick={(e) => e.stopPropagation()}
            className="text-cobalt-600 hover:underline"
          >
            {w.server.name}
            <span className="mt-1 block font-mono text-xs text-neutral-500">{w.server.host ?? "—"}</span>
          </Link>
        ) : (
          <span className="text-neutral-400">—</span>
        ),
    },
    {
      key: "path",
      header: "Path",
      mono: true,
      className: "max-w-[220px]",
      render: (w) => (
        <span className="block truncate text-neutral-500" title={w.path}>
          {w.path}
        </span>
      ),
    },
    {
      key: "database",
      header: "Database",
      sortKey: "database",
      render: (w) =>
        w.dbInstance ? (
          <Link
            href="/databases"
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[13px] text-cobalt-600 hover:underline"
          >
            {w.dbInstance.name}
          </Link>
        ) : (
          <span className="text-neutral-400">—</span>
        ),
    },
    {
      key: "credential",
      header: "Credential",
      render: (w) => <Badge variant="cobalt">{w.credentialLabel}</Badge>,
    },
    ...(writable
      ? [
        {
          key: "actions",
          header: "",
          className: "w-12 text-right",
          render: (w: WebsiteDto) => (
            renderActions(w)
          ),
        },
      ]
      : []),
  ];

  const preferences = useCollectionPreferences("websites",
    { view: "list", sort: "domain", direction: "asc", group: "none" }, SORT_OPTIONS, GROUP_OPTIONS);
  const hostLabel = (website: WebsiteDto) => website.server?.host || `Unknown host · ${website.server?.name ?? website.serverId}`;
  const groupBy = preferences.group === "host" ? hostLabel : undefined;
  const rows = sortCollection(websites.data ?? [], (website) => {
    switch (preferences.sort) {
      case "host": return hostLabel(website);
      case "server": return website.server?.name ?? "";
      case "database": return website.dbInstance?.name ?? "";
      case "created": return website.createdAt;
      default: return website.domain;
    }
  }, preferences.direction);

  function renderActions(w: WebsiteDto) {
    if (!writable) return null;
    return (<span onClick={(e) => e.stopPropagation()}>
      <DropdownMenu
        align="end"
        trigger={
          <button
            type="button"
            aria-label={`Actions for ${w.domain}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-neutral-400 transition-colors hover:bg-cobalt-50 hover:text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
          >
            <Ellipsis size={16} strokeWidth={1.75} />
          </button>
        }
        items={[
          {
            label: "Edit",
            icon: <Pencil size={15} strokeWidth={1.75} />,
            onSelect: () => openEdit(w),
          },
          { type: "separator" as const },
          {
            label: "Delete",
            icon: <Trash2 size={15} strokeWidth={1.75} />,
            danger: true,
            onSelect: () => setDeleting(w),
          },
        ]}
      />
    </span>);
  }

  function renderWebsite(w: WebsiteDto) {
    const expanded = openDetails.has(w.id);
    return (
      <Card key={w.id} hoverable className="flex min-w-0 flex-col p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <a href={`https://${w.domain}`} target="_blank" rel="noopener noreferrer"
            className="inline-flex min-w-0 items-start gap-2 break-all font-semibold text-cobalt-600 hover:underline">
            {w.domain}<ExternalLink className="mt-1 shrink-0" size={14} aria-hidden />
          </a>
          {renderActions(w)}
        </div>
        <dl className="space-y-3 text-sm">
          <div><dt className="mb-1 text-xs text-neutral-500">Server / IP</dt>
            <dd><Link href={`/servers/${w.serverId}`} className="text-cobalt-600 hover:underline">{w.server?.name ?? "Unknown server"}</Link>
              <span className="mt-1 block break-all font-mono text-xs text-neutral-500">{w.server?.host ?? "—"}</span></dd></div>
          <div><dt className="mb-1 text-xs text-neutral-500">Path</dt><dd className="break-all font-mono text-xs">{w.path}</dd></div>
          <div><dt className="mb-1 text-xs text-neutral-500">Database</dt><dd>{w.dbInstance ? <Link href="/databases" className="text-cobalt-600 hover:underline">{w.dbInstance.name}</Link> : "No linked database"}</dd></div>
        </dl>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-5">
          <Badge variant="cobalt">{w.credentialLabel}</Badge>
          <Button variant="secondary" size="sm" aria-expanded={expanded} aria-controls={`website-details-${w.id}`}
            onClick={() => setOpenDetails((current) => {
              const updated = new Set(current);
              if (updated.has(w.id)) updated.delete(w.id); else updated.add(w.id);
              return updated;
            })}>{expanded ? "Hide details" : "Credentials & notes"}</Button>
        </div>
        {expanded && <div id={`website-details-${w.id}`} className="mt-4 border-t border-neutral-100 pt-4"><CredentialBlock website={w} canReveal={canReveal} /></div>}
      </Card>
    );
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Site map</SectionLabel>
          <h2 className="mt-1 text-[26px] font-bold tracking-tight">Websites</h2>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            Every domain, which server it lives on, and how to get into it.
            Open an item’s details for credentials and notes.
          </p>
        </div>
        {writable ? (
          <Button onClick={openCreate}>
            <Plus size={16} strokeWidth={2} aria-hidden />
            Add website
          </Button>
        ) : null}
      </div>

      {websites.isError ? (
        <Alert variant="danger" title="Could not load websites">{websites.error.message}</Alert>
      ) : websites.isPending ? (
        <Card><p className="px-5 py-10 text-center text-sm text-neutral-500">Loading websites…</p></Card>
      ) : rows.length === 0 ? (
        <Card><EmptyState icon={Globe} message="No websites yet — add the first one."
          action={writable ? <Button size="sm" onClick={openCreate}>Add website</Button> : undefined} /></Card>
      ) : (
        <>
          <CollectionToolbar count={rows.length} {...preferences} />
          {preferences.view === "list" ? (
            <Card><DataTable columns={columns} rows={rows} rowKey={(website) => website.id} groupBy={groupBy} sort={preferences.tableSort}
              renderExpanded={(website) => <CredentialBlock website={website} canReveal={canReveal} />} /></Card>
          ) : (
            <div className="space-y-6">
              {groupCollection(rows, groupBy).map(([label, members]) => (
                <section key={label || "all"}>
                  {groupBy && <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-700">{label}<span className="font-normal text-neutral-500">({members.length})</span></h3>}
                  <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,330px),1fr))]">
                    {members.map(renderWebsite)}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <WebsiteFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        website={editing}
      />

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete website"
        variant="danger"
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      >
        <b>Removes the record for {deleting?.domain}.</b> Files on the server
        are untouched — this only deletes WHARF&apos;s metadata and the stored
        credential.
      </ConfirmModal>
    </div>
  );
}
