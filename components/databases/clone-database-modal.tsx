"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { INSTANCES_QUERY_KEY, cloneInstance, type InstanceDto } from "./api";
import { ProvisionProgress } from "./provision-progress";

const INPUT_CLASSES =
  "min-h-11 w-full rounded-[6px] border border-neutral-200 bg-white px-3 py-2 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 disabled:opacity-50 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none";

export interface CloneDatabaseModalProps {
  source: InstanceDto;
  instances: InstanceDto[];
  onClose: () => void;
  /** Allows the destination card to leave terminal feedback to this modal. */
  onCloning: (targetInstanceId: string) => void;
  onNewInstance: () => void;
}

/** Mounted afresh for each source; the selected destination is never prefilled. */
export function CloneDatabaseModal({
  source,
  instances,
  onClose,
  onCloning,
  onNewInstance,
}: CloneDatabaseModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [targetId, setTargetId] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [startedTarget, setStartedTarget] = useState<InstanceDto | null>(null);
  const [finished, setFinished] = useState<"ok" | "error" | null>(null);
  const submitting = useRef(false);

  const destinations = instances.filter(
    (instance) => instance.id !== source.id && instance.status === "running" && !instance.activeJob,
  );
  const target = destinations.find((instance) => instance.id === targetId);
  const currentSource = instances.find((instance) => instance.id === source.id);
  const sourceReady = currentSource?.status === "running" && !currentSource.activeJob;

  const clone = useMutation({
    mutationFn: (destination: InstanceDto) => cloneInstance(source.id, destination.id, confirmText),
    onSuccess: (result, destination) => {
      setStartedTarget({ ...destination, id: result.targetInstanceId });
      onCloning(result.targetInstanceId);
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
    },
    onError: (error: Error) => {
      submitting.current = false;
      setFormError(error.message);
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
    },
  });

  // Keep the initiating request visible until the server accepts or rejects it.
  // Once accepted, closing is safe: the destination card follows the same job.
  const handleClose = useCallback(() => {
    if (!clone.isPending) onClose();
  }, [clone.isPending, onClose]);

  const valid = sourceReady && !!target && confirmText === target.name;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid || !target || clone.isPending || submitting.current) return;
    submitting.current = true;
    setFormError(null);
    clone.mutate(target);
  }

  const title = startedTarget
    ? `${finished === "ok" ? "Clone complete" : finished === "error" ? "Clone failed" : "Cloning"} — ${startedTarget.name}`
    : `Clone database — ${source.name}`;

  return (
    <Dialog open onClose={handleClose} ariaLabel={title} wide className="[&_h3]:min-w-0 [&_h3]:break-words">
      <ModalHead title={title} onClose={handleClose} />
      {startedTarget ? (
        <>
          <ModalBody className="flex flex-col gap-4">
            <p className="text-[13px] text-neutral-600">
              <b className="text-ink">{source.name}</b> → <b className="text-ink">{startedTarget.name}</b>
              <span className="mt-1 block break-all font-mono text-xs">https://{startedTarget.apiSubdomain}</span>
            </p>
            {finished ? (
              <Alert variant={finished === "ok" ? "success" : "danger"} title={finished === "ok" ? "Database cloned successfully." : "Database clone failed."}>
                {finished === "ok"
                  ? `${startedTarget.name} now has the source schema and data. Connect using the destination’s own URL and credentials.`
                  : "Review the log below for the failed step and recovery details. The log is also saved on the destination’s card."}
              </Alert>
            ) : null}
            <ProvisionProgress
              instanceId={startedTarget.id}
              kind="clone"
              title={`${startedTarget.composeProjectName} · ${startedTarget.server?.name ?? "server"}`}
              onTerminal={(status) => {
                setFinished(status);
                void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
                toast({
                  title: status === "ok" ? "Database cloned" : "Clone failed",
                  message: status === "ok"
                    ? `${source.name} copied to ${startedTarget.name}.`
                    : `${startedTarget.name} clone failed — review its log for recovery details.`,
                  variant: status === "ok" ? "success" : "danger",
                });
              }}
            />
            <p className="text-xs text-neutral-500">
              You can close this window. The clone continues on the server, and its progress is available on the destination’s card.
            </p>
          </ModalBody>
          <ModalFoot>
            <Button variant={finished === "ok" ? "primary" : "secondary"} onClick={handleClose}>
              {finished === "ok" ? "Done — back to fleet" : "Close"}
            </Button>
          </ModalFoot>
        </>
      ) : (
        <form onSubmit={handleSubmit}>
          <ModalBody className="flex flex-col gap-4">
            <p className="text-[13px] text-neutral-600">
              Copy this live database’s schema and data into another WHARF instance. The destination keeps its own URL, credentials and settings.
            </p>
            {formError ? <Alert variant="danger" title="Clone could not start">{formError}</Alert> : null}
            <div className="rounded-[8px] border border-neutral-200 bg-neutral-50 p-3.5">
              <span className="label-track mb-1 block text-neutral-500">Source database</span>
              <DatabaseIdentity instance={source} />
            </div>
            {!sourceReady ? (
              <Alert variant="warning">The source is no longer available. It must be running with no other active job before you can clone it.</Alert>
            ) : null}
            {destinations.length === 0 ? (
              <Alert variant="info" title="No destination available">
                <p>Create or start another database instance, then return here to clone into it. Only running instances without an active job can receive a clone.</p>
                <Button variant="secondary" size="sm" className="mt-3" disabled={clone.isPending} onClick={onNewInstance}>New instance</Button>
              </Alert>
            ) : (
              <div>
                <label htmlFor="clone-target" className="label-track mb-1.5 block text-neutral-500">Destination database</label>
                <select
                  id="clone-target"
                  className={INPUT_CLASSES}
                  value={targetId}
                  disabled={clone.isPending}
                  required
                  aria-describedby="clone-target-help"
                  onChange={(event) => {
                    setTargetId(event.target.value);
                    setConfirmText("");
                    setFormError(null);
                  }}
                >
                  <option value="">Choose a destination…</option>
                  {targetId && !target ? <option value={targetId} disabled>Previously selected destination is unavailable</option> : null}
                  {destinations.map((destination) => (
                    <option key={destination.id} value={destination.id}>
                      {destination.name} · {destination.server?.name ?? destination.serverId} · {destination.apiSubdomain}
                    </option>
                  ))}
                </select>
                <p id="clone-target-help" className="mt-1.5 text-xs text-neutral-500">Choose another running database on this server or a different WHARF server.</p>
              </div>
            )}
            {targetId && !target ? (
              <Alert variant="warning">The selected destination is no longer available. Choose another running instance.</Alert>
            ) : null}
            {target ? (
              <>
                <div className="rounded-[8px] border border-neutral-200 p-3.5">
                  <span className="label-track mb-1 block text-neutral-500">Destination to overwrite</span>
                  <DatabaseIdentity instance={target} />
                </div>
                <Alert variant="warning" title="The destination database will be overwritten.">
                  All current schema and data in <b>{target.name}</b> will be replaced. A safety snapshot is kept on its server before replacement. The destination may be briefly unavailable during the switch.
                </Alert>
                <div>
                  <label htmlFor="clone-confirm" className="label-track mb-1.5 block text-neutral-500">
                    Type <span className="normal-case tracking-normal text-danger">{target.name}</span> to confirm
                  </label>
                  <input
                    id="clone-confirm"
                    className={`${INPUT_CLASSES} font-mono`}
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    placeholder={target.name}
                    disabled={clone.isPending}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </div>
              </>
            ) : null}
            <p className="text-xs text-neutral-500">
              Includes application schemas, database data, Auth users and Storage metadata. Uploaded Storage files are not copied. This is a point-in-time copy; later source changes are not synced.
            </p>
          </ModalBody>
          <ModalFoot className="flex-wrap">
            <Button variant="secondary" onClick={handleClose} disabled={clone.isPending}>Cancel</Button>
            <Button type="submit" variant="danger" disabled={!valid || clone.isPending}>
              <Copy size={15} strokeWidth={1.75} aria-hidden />
              {clone.isPending ? "Starting clone…" : "Overwrite & clone database"}
            </Button>
          </ModalFoot>
        </form>
      )}
    </Dialog>
  );
}

function DatabaseIdentity({ instance }: { instance: InstanceDto }) {
  return (
    <div className="min-w-0 text-[13px]">
      <p className="break-words font-semibold text-ink">{instance.name}</p>
      <p className="mt-0.5 break-words text-neutral-600">{instance.server?.name ?? instance.serverId}</p>
      <p className="mt-1 break-all font-mono text-xs text-neutral-600">https://{instance.apiSubdomain}</p>
    </div>
  );
}
