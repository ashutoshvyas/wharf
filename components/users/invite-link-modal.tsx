"use client";

/**
 * One-time invite / reset link panel.
 *
 * Shown immediately after a create or a reset, because the raw token exists
 * nowhere else: only its SHA-256 is stored (lib/users/invite.ts), so closing
 * this modal without copying the link means reissuing it. The info Alert says
 * exactly that, plus the 48-hour expiry.
 */
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { MonoField } from "@/components/ui/mono-field";

export interface InviteLinkModalProps {
  open: boolean;
  onClose: () => void;
  /** Who the link is for — shown in the copy. */
  email: string;
  inviteUrl: string;
  /** Reset wording differs slightly from a first invite. */
  kind: "invite" | "reset";
}

export function InviteLinkModal({
  open,
  onClose,
  email,
  inviteUrl,
  kind,
}: InviteLinkModalProps) {
  const title = kind === "invite" ? "User added" : "Reset link ready";

  return (
    <Dialog open={open} onClose={onClose} wide>
      <ModalHead title={title} onClose={onClose} />
      <ModalBody className="flex flex-col gap-4">
        <p className="text-[13.5px] text-neutral-700">
          {kind === "invite" ? (
            <>
              <b>{email}</b> can now set a password. Send them this link — it is
              the only way into the account.
            </>
          ) : (
            <>
              The previous password for <b>{email}</b> no longer works. Send
              them this link to set a new one.
            </>
          )}
        </p>

        <MonoField label="Set-password link" value={inviteUrl} />

        <Alert variant="info" title="Shown once, expires in 48 hours">
          WHARF stores only a hash of this token, so it cannot be shown again.
          Copy it now — if it is lost or expires, issue a new one with
          <em> Send reset link</em>. The link works a single time.
        </Alert>
      </ModalBody>
      <ModalFoot>
        <Button onClick={onClose}>Done</Button>
      </ModalFoot>
    </Dialog>
  );
}
