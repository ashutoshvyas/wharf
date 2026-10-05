"use client";

/**
 * Last-action log tail (design §6 "errors keep their evidence").
 *
 * The source is the DTO's `lastActionLog` — a failed run's evidence stays
 * pinned to the entity and remains viewable after a later success, because the
 * engine only overwrites it on the next action.
 */
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { LogStream } from "@/components/ui/log-stream";
import { StatusBadge } from "@/components/ui/status-badge";
import type { InstanceDto } from "./api";
import { parseLogTail } from "./provision-progress";

export function LogTailModal({
  open,
  onClose,
  instance,
}: {
  open: boolean;
  onClose: () => void;
  instance: InstanceDto | null;
}) {
  if (!instance) return null;
  const lines = parseLogTail(instance.lastActionLog);

  return (
    <Dialog open={open} onClose={onClose} wide>
      <ModalHead title={`Log — ${instance.name}`} onClose={onClose} />
      <ModalBody>
        {lines.length > 0 ? (
          <LogStream
            title={`last action · ${instance.composeProjectName}`}
            lines={lines}
            maxHeight={380}
            rightSlot={<StatusBadge status={instance.status} />}
          />
        ) : (
          <p className="text-[13px] text-neutral-500">
            No log recorded for this instance yet.
          </p>
        )}
      </ModalBody>
      <ModalFoot>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFoot>
    </Dialog>
  );
}
