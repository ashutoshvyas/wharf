"use client";

/**
 * Users screen (, design §5.11 + prototype viewUsers()).
 *
 * DataTable: avatar initial + email (with a "you" Badge on your own row) ·
 * role Badge (cobalt for admin, neutral otherwise) · created date · row
 * DropdownMenu (Edit role / Send reset link / Remove).
 *
 * The row menu is HIDDEN on your own row — not disabled — because every
 * action it offers is refused for yourself server-side (lib/users/guards.ts).
 * The remaining server guards (last admin, duplicate email) come back as 409
 * and are surfaced verbatim as danger toasts, which stay until dismissed.
 *
 * The whole screen is admin-only; the page wrapper redirects everyone else,
 * so there is no further role branching here.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, KeyRound, Pencil, Plus, Trash2, Users } from "lucide-react";
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
import {
  ApiError,
  USERS_QUERY_KEY,
  deleteUser,
  fetchUsers,
  formatDate,
  resetUserPassword,
  type UserDto,
} from "./api";
import { InviteLinkModal } from "./invite-link-modal";
import { UserFormModal } from "./user-form-modal";

interface IssuedLink {
  email: string;
  inviteUrl: string;
  kind: "invite" | "reset";
}

export function UsersView({ currentUserEmail }: { currentUserEmail: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [deleting, setDeleting] = useState<UserDto | null>(null);
  const [issued, setIssued] = useState<IssuedLink | null>(null);

  const users = useQuery({ queryKey: USERS_QUERY_KEY, queryFn: fetchUsers });

  /** Danger toast for 409 guard failures; generic danger toast otherwise. */
  function reportError(title: string, err: Error) {
    toast({
      title: err instanceof ApiError && err.status === 409 ? "Not allowed" : title,
      message: err.message,
      variant: "danger",
    });
  }

  const remove = useMutation({
    mutationFn: (user: UserDto) => deleteUser(user.id),
    onSuccess: (_data, user) => {
      void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      toast({ message: `${user.email} removed`, variant: "success" });
      setDeleting(null);
    },
    onError: (err: Error) => {
      reportError("Remove failed", err);
      setDeleting(null);
    },
  });

  const reset = useMutation({
    mutationFn: (user: UserDto) => resetUserPassword(user.id),
    onSuccess: ({ inviteUrl }, user) => {
      void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      setIssued({ email: user.email, inviteUrl, kind: "reset" });
    },
    onError: (err: Error) => reportError("Reset failed", err),
  });

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(user: UserDto) {
    setEditing(user);
    setFormOpen(true);
  }

  const columns: DataTableColumn<UserDto>[] = [
    {
      key: "email",
      header: "User",
      render: (u) => (
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cobalt-50 text-[12px] font-semibold text-cobalt-700"
          >
            {u.email.charAt(0).toUpperCase()}
          </span>
          <span className="truncate">{u.email}</span>
          {u.email === currentUserEmail ? (
            <Badge variant="cobalt">you</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "role",
      header: "Role",
      className: "w-[140px]",
      render: (u) => (
        <Badge
          variant={u.role === "admin" ? "cobalt" : "neutral"}
          className="font-mono text-[11px] uppercase tracking-[0.08em]"
        >
          {u.role}
        </Badge>
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      className: "w-[150px] text-neutral-500",
      render: (u) => formatDate(u.createdAt),
    },
    {
      key: "actions",
      header: "",
      className: "w-12 text-right",
      render: (u) =>
        // Own row: no menu at all — every item is refused server-side anyway.
        u.email === currentUserEmail ? null : (
          <span onClick={(e) => e.stopPropagation()}>
            <DropdownMenu
              align="end"
              trigger={
                <button
                  type="button"
                  aria-label={`Actions for ${u.email}`}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-neutral-400 transition-colors hover:bg-cobalt-50 hover:text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
                >
                  <Ellipsis size={16} strokeWidth={1.75} />
                </button>
              }
              items={[
                {
                  label: "Edit role",
                  icon: <Pencil size={15} strokeWidth={1.75} />,
                  onSelect: () => openEdit(u),
                },
                {
                  label: "Send reset link",
                  icon: <KeyRound size={15} strokeWidth={1.75} />,
                  onSelect: () => reset.mutate(u),
                },
                { type: "separator" as const },
                {
                  label: "Remove user",
                  icon: <Trash2 size={15} strokeWidth={1.75} />,
                  danger: true,
                  onSelect: () => setDeleting(u),
                },
              ]}
            />
          </span>
        ),
    },
  ];

  const rows = users.data ?? [];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Access</SectionLabel>
          <h2 className="mt-1 text-[26px] font-bold tracking-tight">
            Panel users
          </h2>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            admin — full control · operator — day-to-day, no removal · viewer —
            read-only.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus size={16} strokeWidth={2} aria-hidden />
          Add user
        </Button>
      </div>

      {users.isError ? (
        <Alert variant="danger" title="Could not load users">
          {users.error.message}
        </Alert>
      ) : (
        <Card>
          {users.isPending ? (
            <p className="px-5 py-10 text-center text-[13px] text-neutral-500">
              Loading users…
            </p>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Users}
              message="No panel users yet — add the first one."
              action={
                <Button size="sm" onClick={openCreate}>
                  Add user
                </Button>
              }
            />
          ) : (
            <DataTable columns={columns} rows={rows} rowKey={(u) => u.id} />
          )}
        </Card>
      )}

      <UserFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        user={editing}
        onInvited={(email, inviteUrl) =>
          setIssued({ email, inviteUrl, kind: "invite" })
        }
      />

      <InviteLinkModal
        open={issued !== null}
        onClose={() => setIssued(null)}
        email={issued?.email ?? ""}
        inviteUrl={issued?.inviteUrl ?? ""}
        kind={issued?.kind ?? "invite"}
      />

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Remove user"
        variant="danger"
        confirmLabel="Remove user"
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
      >
        <b>Removes panel access for {deleting?.email}.</b> Any session they
        currently hold stops working at its next request. Their audit-log
        history is kept — the trail is insert-only and never rewritten.
      </ConfirmModal>
    </div>
  );
}
