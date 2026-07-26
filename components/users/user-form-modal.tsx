"use client";

/**
 * Add-user / edit-role modal (, design §5.11 + prototype userModal()).
 *
 * One component for both jobs, mirroring the prototype: creating asks for an
 * email + role, editing locks the email (it is the login identity and the
 * audit-log join key) and offers only the role select.
 *
 * The role options carry the one-line descriptions from design §5.11
 * verbatim — "admin — full control · operator — day-to-day, no removal ·
 * viewer — read-only" — so the select and the page subtitle agree word for
 * word.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  ApiError,
  ROLE_OPTIONS,
  USERS_QUERY_KEY,
  createUser,
  updateUserRole,
  type UserDto,
  type UserRole,
} from "./api";

const FIELD_CLASSES =
  "h-10 w-full rounded-[6px] border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none " +
  "disabled:bg-neutral-50 disabled:text-neutral-500";

export interface UserFormModalProps {
  open: boolean;
  onClose: () => void;
  /** null = create; a user = edit that user's role. */
  user: UserDto | null;
  /** Called with the one-time invite URL after a successful create. */
  onInvited: (email: string, inviteUrl: string) => void;
}

export function UserFormModal({
  open,
  onClose,
  user,
  onInvited,
}: UserFormModalProps) {
  const editing = user !== null;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("operator");
  const [error, setError] = useState<string | null>(null);

  // Reset every time the modal opens so a previous edit never bleeds through.
  useEffect(() => {
    if (!open) return;
    setEmail(user?.email ?? "");
    setRole(user?.role ?? "operator");
    setError(null);
  }, [open, user]);

  const invite = useMutation({
    mutationFn: () => createUser({ email: email.trim().toLowerCase(), role }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      onInvited(created.email, created.inviteUrl);
      onClose();
    },
    onError: (err: Error) => handleError(err),
  });

  const changeRole = useMutation({
    mutationFn: () => updateUserRole(user!.id, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      toast({ message: "Role updated", variant: "success" });
      onClose();
    },
    onError: (err: Error) => handleError(err),
  });

  /** 409 guard failures (last admin / self / duplicate) get a danger toast. */
  function handleError(err: Error) {
    if (err instanceof ApiError && err.status === 409) {
      toast({ title: "Not allowed", message: err.message, variant: "danger" });
      return;
    }
    setError(err.message);
  }

  const pending = invite.isPending || changeRole.isPending;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (editing) {
      changeRole.mutate();
      return;
    }
    const trimmed = email.trim();
    if (!trimmed.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    invite.mutate();
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <ModalHead title={editing ? "Edit user" : "Add user"} onClose={onClose} />
      <form onSubmit={onSubmit}>
        <ModalBody className="flex flex-col gap-4">
          {error ? <Alert variant="danger">{error}</Alert> : null}

          <div>
            <label
              htmlFor="user-email"
              className="label-track mb-1.5 block text-neutral-500"
            >
              Email
            </label>
            <input
              id="user-email"
              type="email"
              required
              autoComplete="off"
              spellCheck={false}
              disabled={editing}
              placeholder="teammate@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={FIELD_CLASSES}
            />
          </div>

          <div>
            <label
              htmlFor="user-role"
              className="label-track mb-1.5 block text-neutral-500"
            >
              Role
            </label>
            <select
              id="user-role"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className={FIELD_CLASSES}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} — {option.description}
                </option>
              ))}
            </select>
          </div>

          {editing ? null : (
            <p className="text-[12.5px] text-neutral-500">
              Creating the user produces a single-use set-password link, shown
              once on the next screen. Until it is redeemed the account cannot
              sign in.
            </p>
          )}
        </ModalBody>
        <ModalFoot>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending
              ? editing
                ? "Saving…"
                : "Creating…"
              : editing
                ? "Save"
                : "Add user"}
          </Button>
        </ModalFoot>
      </form>
    </Dialog>
  );
}
