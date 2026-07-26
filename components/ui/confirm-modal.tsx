"use client";

import { useEffect, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";

export interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Plain-language consequence copy — state exactly what is destroyed. */
  children?: ReactNode;
  /** Exact string the user must type before confirm enables (e.g. instance name). */
  typeToConfirm?: string;
  /** Extra checkbox label the user must tick before confirm enables, alongside typeToConfirm. */
  requireAck?: string;
  /** Fires whenever the requireAck checkbox changes (including the reset on open/close). */
  onAckChange?: (acked: boolean) => void;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger renders the warning icon + danger confirm button. */
  variant?: "danger" | "default";
  onConfirm: () => void;
  /** Disables both buttons (e.g. while the destructive call is in flight). */
  busy?: boolean;
}

export function ConfirmModal({
  open,
  onClose,
  title,
  children,
  typeToConfirm,
  requireAck,
  onAckChange,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  onConfirm,
  busy = false,
}: ConfirmModalProps) {
  const [typed, setTyped] = useState("");
  const [acked, setAcked] = useState(false);

  // Reset the type-to-confirm input and ack checkbox every time the modal opens.
  useEffect(() => {
    if (open) {
      setTyped("");
      setAcked(false);
      onAckChange?.(false);
    }
    // onAckChange is a per-render closure the caller doesn't memoize — only
    // `open` should retrigger this reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const matches = (!typeToConfirm || typed === typeToConfirm) && (!requireAck || acked);

  return (
    <Dialog open={open} onClose={onClose} ariaLabel={title}>
      <ModalHead title={title} onClose={onClose} />
      <ModalBody>
        {variant === "danger" ? (
          <div className="mb-3.5 inline-flex h-11 w-11 items-center justify-center rounded-full bg-[rgba(216,73,60,0.1)] text-danger">
            <TriangleAlert size={22} strokeWidth={1.75} />
          </div>
        ) : null}
        <div className="text-[13.5px] leading-relaxed text-neutral-700">
          {children}
        </div>
        {typeToConfirm ? (
          <div className="mt-4">
            <label
              htmlFor="confirm-modal-input"
              className="label-track mb-1.5 block text-neutral-500"
            >
              Type{" "}
              <span className="normal-case tracking-normal text-danger">
                {typeToConfirm}
              </span>{" "}
              to confirm
            </label>
            <input
              id="confirm-modal-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={typeToConfirm}
              className="h-10 w-full rounded-[6px] border border-neutral-200 bg-white px-3 font-mono text-[13px] text-ink transition-shadow focus:border-cobalt-400 focus:outline-none focus:ring-2 focus:ring-[rgba(92,120,227,0.25)]"
            />
          </div>
        ) : null}
        {requireAck ? (
          <label className="mt-4 flex items-start gap-2.5 text-[13px] text-neutral-700">
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => {
                setAcked(e.target.checked);
                onAckChange?.(e.target.checked);
              }}
              className="mt-0.5 h-4 w-4 shrink-0 rounded-[3px] border-neutral-300 text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
            />
            {requireAck}
          </label>
        ) : null}
      </ModalBody>
      <ModalFoot>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          variant={variant === "danger" ? "danger" : "primary"}
          onClick={onConfirm}
          disabled={!matches || busy}
        >
          {confirmLabel}
        </Button>
      </ModalFoot>
    </Dialog>
  );
}
