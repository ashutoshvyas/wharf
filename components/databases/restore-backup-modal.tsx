"use client";

/**
 * Restore backup modal — upload a Postgres backup (downloaded from
 * an existing Supabase project) and load it into this instance, replacing
 * its current data.
 *
 * Same "form → mutation → swap to progress" handoff as NewInstanceModal, but
 * scoped to one already-known instance rather than picking a server — the
 * target is fixed, so the only inputs are the file and the type-the-name
 * confirmation (destructive, same convention as Remove).
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileWarning } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError, INSTANCES_QUERY_KEY, restoreInstance, type InstanceDto } from "./api";
import { ProvisionProgress } from "./provision-progress";

const INPUT_CLASSES =
  "h-10 w-full rounded-[6px] border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none";

/** Client-side pre-check only — the server re-validates authoritatively. */
const ALLOWED_EXTENSIONS = [".zip", ".backup", ".dump", ".sql"];

function hasAllowedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface RestoreBackupModalProps {
  open: boolean;
  onClose: () => void;
  instance: InstanceDto | null;
}

export function RestoreBackupModal({ open, onClose, instance }: RestoreBackupModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState<"ok" | "error" | null>(null);
  const submitting = useRef(false);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setConfirmText("");
    setFormError(null);
    setStarted(false);
    setFinished(null);
    submitting.current = false;
  }, [open]);

  const restore = useMutation({
    mutationFn: () => restoreInstance(instance!.id, confirmText, file!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
      setStarted(true);
    },
    onError: (err: Error) => {
      submitting.current = false;
      setFormError(
        err instanceof ApiError && err.status === 409
          ? `${err.message} — try again once that job finishes.`
          : err.message,
      );
    },
  });

  const fileError =
    file && !hasAllowedExtension(file.name)
      ? "Must be a .zip, .backup, .dump, or .sql file."
      : null;

  const valid =
    !!instance &&
    !!file &&
    !fileError &&
    confirmText === instance.name;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || submitting.current || restore.isPending) return;
    submitting.current = true;
    setFormError(null);
    restore.mutate();
  }

  if (!instance) return null;

  return (
    <Dialog open={open} onClose={onClose} wide>
      <ModalHead
        title={started ? `Restoring — ${instance.name}` : `Restore backup — ${instance.name}`}
        onClose={onClose}
      />

      {started ? (
        <>
          <ModalBody>
            <ProvisionProgress
              instanceId={instance.id}
              kind="restore"
              title={`${instance.composeProjectName} · ${instance.server?.name ?? "server"}`}
              onTerminal={(status) => {
                setFinished(status);
                void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
                toast({
                  title: status === "ok" ? "Restored" : undefined,
                  message:
                    status === "ok"
                      ? `${instance.name} restored — a snapshot of its previous data was kept on the server.`
                      : `${instance.name} restore failed — the log is kept on its card.`,
                  variant: status === "ok" ? "success" : "danger",
                });
              }}
            />
            <p className="mt-2.5 text-xs text-neutral-500">
              You can close this — the restore continues on the server and the
              fleet card stays live.
            </p>
          </ModalBody>
          <ModalFoot>
            <Button
              variant={finished === "ok" ? "primary" : "secondary"}
              onClick={onClose}
            >
              {finished === "ok" ? "Done — back to fleet" : "Close"}
            </Button>
          </ModalFoot>
        </>
      ) : (
        <form onSubmit={handleSubmit}>
          <ModalBody className="flex flex-col gap-4">
            {formError ? <Alert variant="danger">{formError}</Alert> : null}

            <Alert
              variant="warning"
              icon={<FileWarning size={17} strokeWidth={1.75} />}
              title="This replaces ALL data in this instance."
            >
              The uploaded backup overwrites everything currently in{" "}
              <span className="font-mono text-[12.5px] text-ink">{instance.name}</span>.
              A safety snapshot of the current data is taken automatically right
              before the restore and kept on the server — but there is no
              one-click undo, so make sure this is the right instance.
            </Alert>

            <div>
              <label
                htmlFor="rb-file"
                className="label-track mb-1.5 block text-neutral-500"
              >
                Backup file
              </label>
              <input
                id="rb-file"
                type="file"
                accept=".zip,.backup,.dump,.sql"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-[13px] text-neutral-700 file:mr-3 file:rounded-[6px] file:border-0 file:bg-cobalt-50 file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-cobalt-700 hover:file:bg-cobalt-100"
              />
              <p className="mt-1.5 text-xs text-neutral-500">
                A .backup/.dump file downloaded from an existing Supabase
                project, or a .zip containing one.
              </p>
              {fileError ? (
                <p className="mt-1 text-[13px] text-danger">{fileError}</p>
              ) : null}
            </div>

            <div>
              <label
                htmlFor="rb-confirm"
                className="label-track mb-1.5 block text-neutral-500"
              >
                Type{" "}
                <span className="normal-case tracking-normal text-danger">
                  {instance.name}
                </span>{" "}
                to confirm
              </label>
              <input
                id="rb-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={instance.name}
                autoComplete="off"
                spellCheck={false}
                className={`${INPUT_CLASSES} font-mono text-[13px]`}
              />
            </div>
          </ModalBody>
          <ModalFoot>
            <Button variant="secondary" onClick={onClose} disabled={restore.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={!valid || restore.isPending}
            >
              {restore.isPending ? "Uploading…" : "Restore backup"}
            </Button>
          </ModalFoot>
        </form>
      )}
    </Dialog>
  );
}
