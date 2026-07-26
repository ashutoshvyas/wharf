"use client";

/**
 * Servers screen (, design §5.2 + prototype viewServers()).
 *
 * Card grid of registered hosts: name + bootstrap StatusBadge (unreachable
 * wins), mono user@host:port · auth line, tag pills, hosted counts, and the
 * actions row (Terminal / Open panel ↗ / overflow Edit-Delete). Write
 * actions are HIDDEN (never disabled) per the RBAC matrix (design §6).
 */
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ellipsis,
  ExternalLink,
  Pencil,
  Plus,
  Server,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { DropdownMenu } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import {
  ApiError,
  deleteServer,
  fetchServers,
  formatDeleteConflict,
  type ServerDto,
} from "./api";
import { ServerFormModal } from "./server-form-modal";

/** Unreachable wins over bootstrapped / not bootstrapped (design §4.2). */
export function serverStatus(
  server: Pick<ServerDto, "reachable" | "bootstrapped">,
): "unreachable" | "bootstrapped" | "not_bootstrapped" {
  if (server.reachable === false) return "unreachable";
  return server.bootstrapped ? "bootstrapped" : "not_bootstrapped";
}

export function ServersView({ role }: { role: Role }) {
  const writable = can(role, "servers.write");
  const canDelete = can(role, "server.delete");
  const canTerminal = can(role, "terminal");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ServerDto | null>(null);
  const [deleting, setDeleting] = useState<ServerDto | null>(null);

  const servers = useQuery({ queryKey: ["servers"], queryFn: fetchServers });

  const remove = useMutation({
    mutationFn: (id: string) => deleteServer(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast({ message: `${deleting?.name ?? "Server"} deleted`, variant: "success" });
      setDeleting(null);
    },
    onError: (err: Error) => {
      const message =
        err instanceof ApiError && err.status === 409
          ? formatDeleteConflict(err.message)
          : err.message;
      toast({ title: "Cannot delete server", message, variant: "danger" });
      setDeleting(null);
    },
  });

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(server: ServerDto) {
    setEditing(server);
    setModalOpen(true);
  }

  const rows = servers.data ?? [];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Infrastructure</SectionLabel>
          <h2 className="mt-1 text-[26px] font-bold tracking-tight">Servers</h2>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            Registered hosts, reached over SSH. Bootstrap a server before it
            can host databases.
          </p>
        </div>
        {writable ? (
          <Button onClick={openCreate}>
            <Plus size={16} strokeWidth={2} aria-hidden />
            Add server
          </Button>
        ) : null}
      </div>

      {servers.isError ? (
        <Alert variant="danger" title="Could not load servers">
          <p>{servers.error.message}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2.5"
            onClick={() => void servers.refetch()}
          >
            Retry
          </Button>
        </Alert>
      ) : servers.isPending ? (
        <Card>
          <p className="px-5 py-10 text-center text-[13px] text-neutral-500">
            Loading servers…
          </p>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Server}
            message="No servers yet — register your first server."
            action={
              writable ? (
                <Button size="sm" onClick={openCreate}>
                  Add server
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(330px,1fr))]">
          {rows.map((s) => {
            const sites = s.counts?.websites ?? 0;
            const dbs = s.counts?.dbInstances ?? 0;
            return (
              <Card key={s.id} hoverable className="p-5">
                <div className="mb-2.5 flex items-center justify-between gap-2.5">
                  <Link
                    href={`/servers/${s.id}`}
                    className="truncate text-base font-semibold text-cobalt-600 underline-offset-2 hover:underline"
                  >
                    {s.name}
                  </Link>
                  <StatusBadge status={serverStatus(s)} />
                </div>
                <div className="mb-2.5 truncate font-mono text-[12.5px] text-neutral-500">
                  {s.sshUser}@{s.host}:{s.sshPort} ·{" "}
                  {s.authMethod === "private_key" ? "key" : "password"}
                </div>
                {s.tags.length > 0 ? (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {s.tags.map((t) => (
                      <Badge key={t} variant="neutral">
                        {t}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <div className="mb-4 text-[13px] text-neutral-500">
                  {sites} website{sites === 1 ? "" : "s"} · {dbs} database
                  {dbs === 1 ? "" : "s"}
                </div>
                <div className="flex items-center gap-2">
                  {canTerminal ? (
                    <ButtonLink
                      variant="secondary"
                      size="sm"
                      href={`/servers/${s.id}?tab=terminal`}
                    >
                      <SquareTerminal size={14} strokeWidth={1.75} aria-hidden />
                      Terminal
                    </ButtonLink>
                  ) : null}
                  {s.linkedPanelUrl ? (
                    <a
                      href={s.linkedPanelUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={buttonClasses("ghost", "sm")}
                    >
                      Open panel
                      <ExternalLink size={13} strokeWidth={1.75} aria-hidden />
                    </a>
                  ) : null}
                  <span className="flex-1" />
                  {writable || canDelete ? (
                    <DropdownMenu
                      align="end"
                      trigger={
                        <button
                          type="button"
                          aria-label={`Actions for ${s.name}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-neutral-400 transition-colors hover:bg-cobalt-50 hover:text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
                        >
                          <Ellipsis size={16} strokeWidth={1.75} />
                        </button>
                      }
                      items={[
                        ...(writable
                          ? [
                              {
                                label: "Edit",
                                icon: <Pencil size={15} strokeWidth={1.75} />,
                                onSelect: () => openEdit(s),
                              },
                            ]
                          : []),
                        ...(writable && canDelete
                          ? [{ type: "separator" as const }]
                          : []),
                        ...(canDelete
                          ? [
                              {
                                label: "Delete",
                                icon: <Trash2 size={15} strokeWidth={1.75} />,
                                danger: true,
                                onSelect: () => setDeleting(s),
                              },
                            ]
                          : []),
                      ]}
                    />
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ServerFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        server={editing}
      />

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete server"
        variant="danger"
        confirmLabel="Delete server"
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      >
        <b>This removes the registration only.</b> Nothing is changed on the
        machine itself — WHARF just forgets the credentials and metadata for{" "}
        <span className="font-mono text-[12.5px] text-ink">
          {deleting?.name}
        </span>
        . Deletion is refused while websites or databases still reference it.
      </ConfirmModal>
    </div>
  );
}
