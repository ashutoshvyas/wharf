"use client";

/**
 * Websites screen (, design §5.5 + prototype viewWebsites()).
 *
 * DataTable of every tracked domain with row expansion for the credential
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

export function WebsitesView({ role }: { role: Role }) {
  const writable = can(role, "websites.write");
  const canReveal = can(role, "secrets.reveal");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [modalOpen, setModalOpen] = useState(false);
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
      render: (w) =>
        w.server ? (
          <Link
            href="/servers"
            onClick={(e) => e.stopPropagation()}
            className="text-cobalt-600 hover:underline"
          >
            {w.server.name}
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
              <span onClick={(e) => e.stopPropagation()}>
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
              </span>
            ),
          },
        ]
      : []),
  ];

  const rows = websites.data ?? [];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Site map</SectionLabel>
          <h2 className="mt-1 text-[26px] font-bold tracking-tight">Websites</h2>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            Every domain, which server it lives on, and how to get into it.
            Click a row for credentials.
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
        <Alert variant="danger" title="Could not load websites">
          {websites.error.message}
        </Alert>
      ) : (
        <Card>
          {websites.isPending ? (
            <p className="px-5 py-10 text-center text-[13px] text-neutral-500">
              Loading websites…
            </p>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Globe}
              message="No websites yet — add the first one."
              action={
                writable ? (
                  <Button size="sm" onClick={openCreate}>
                    Add website
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(w) => w.id}
              renderExpanded={(w) => (
                <CredentialBlock website={w} canReveal={canReveal} />
              )}
            />
          )}
        </Card>
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
