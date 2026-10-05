"use client";

/**
 * Restore / Sync modal — replace this instance's data,
 * from either of two sources:
 *
 *  - **Upload backup file** — a .zip/.backup/.dump/.sql the operator
 *    downloaded by hand. The bytes are POSTed to the panel and pushed on from
 *    there.
 *  - **Live database** — a hosted Supabase project or any reachable
 *    Postgres, addressed by connection details + (for storage objects) its
 *    service_role key. Nothing is uploaded: the managed server dumps the
 *    source itself. The details are saved encrypted so the same pull can be
 *    repeated later in one click, which is what makes it a *sync*.
 *
 * Both modes share the destructive-action conventions this codebase uses for
 * Remove: type-the-name confirmation, an up-front warning that a safety
 * snapshot is the only way back, and the same "form → mutation → swap to
 * progress" handoff as NewInstanceModal.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileWarning } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  ApiError,
  INSTANCES_QUERY_KEY,
  SYNC_SOURCE_QUERY_KEY,
  fetchSyncSource,
  restoreInstance,
  saveSyncSource,
  syncInstance,
  type InstanceDto,
} from "./api";
import { ProvisionProgress } from "./provision-progress";
import {
  EMPTY_SYNC_SOURCE,
  SyncSourceForm,
  payloadFromState,
  stateFromDto,
  validateSyncSource,
  type SyncSourceFormState,
} from "./sync-source-form";

const INPUT_CLASSES =
  "h-10 w-full rounded-[6px] border border-neutral-200 bg-white px-3 text-sm text-ink " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-cobalt-400 focus:shadow-[0_0_0_2px_rgba(92,120,227,0.25)] focus:outline-none";

/** Client-side pre-check only — the server re-validates authoritatively. */
const ALLOWED_EXTENSIONS = [".zip", ".backup", ".dump", ".sql"];

type Mode = "file" | "live";

function hasAllowedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** `12 Jun 2026, 14:05` */
function formatSyncedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface RestoreBackupModalProps {
  open: boolean;
  onClose: () => void;
  instance: InstanceDto | null;
}

export function RestoreBackupModal({ open, onClose, instance }: RestoreBackupModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<SyncSourceFormState>(EMPTY_SYNC_SOURCE);
  const [confirmText, setConfirmText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [started, setStarted] = useState<Mode | null>(null);
  const [finished, setFinished] = useState<"ok" | "error" | null>(null);
  const submitting = useRef(false);

  // Only fetched while the modal is open — the payload is per-instance and
  // must never be a stale read of another instance's source.
  //
  // `refetchOnWindowFocus` is off here even though it is on globally
  // (components/providers.tsx): this query backs a form the operator is
  // typing into, and alt-tabbing away and back must not re-fetch underneath
  // them. The prefill guards below are the real protection; this just avoids
  // pointless work while the modal is open.
  const storedQuery = useQuery({
    queryKey: [...SYNC_SOURCE_QUERY_KEY, instance?.id],
    queryFn: () => fetchSyncSource(instance!.id),
    enabled: open && !!instance,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const stored = storedQuery.data ?? null;

  /** Prefill happens once per modal open, and never over a typed-in value. */
  const prefilled = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    if (!open) return;
    setMode("file");
    setFile(null);
    setConfirmText("");
    setFormError(null);
    setStarted(null);
    setFinished(null);
    submitting.current = false;
    prefilled.current = false;
    dirty.current = false;
  }, [open]);

  // Prefill from the saved source once it lands — but never again after that,
  // and never over something the operator has typed. Keying this on the
  // query's `dataUpdatedAt` (as it first did) meant every background refetch
  // — including the one `refetchOnWindowFocus` fires on alt-tab — silently
  // reset the form mid-edit.
  useEffect(() => {
    if (!open || storedQuery.isPending) return;
    if (prefilled.current || dirty.current) return;
    prefilled.current = true;
    setSource(stored ? stateFromDto(stored) : EMPTY_SYNC_SOURCE);
  }, [open, storedQuery.isPending, stored]);

  const restore = useMutation({
    mutationFn: () => restoreInstance(instance!.id, confirmText, file!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
      setStarted("file");
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

  // Save-then-start: the engine reads the SAVED row, so persisting the form
  // first is what makes "sync again later" a single click.
  const sync = useMutation({
    mutationFn: async () => {
      await saveSyncSource(instance!.id, payloadFromState(source));
      await queryClient.invalidateQueries({ queryKey: SYNC_SOURCE_QUERY_KEY });
      return syncInstance(instance!.id, confirmText);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
      setStarted("live");
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

  const sourceError =
    mode === "live"
      ? validateSyncSource(
          source,
          !!stored?.pgPasswordConfigured,
          !!stored?.serviceRoleKeyConfigured,
        )
      : null;

  const pending = restore.isPending || sync.isPending;
  const valid =
    !!instance &&
    confirmText === instance.name &&
    (mode === "file" ? !!file && !fileError : sourceError === null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || submitting.current || pending) return;
    submitting.current = true;
    setFormError(null);
    if (mode === "file") restore.mutate();
    else sync.mutate();
  }

  if (!instance) return null;

  const titleVerb = started === "live" ? "Syncing" : started ? "Restoring" : "Restore / Sync";

  return (
    <Dialog open={open} onClose={onClose} wide>
      <ModalHead title={`${titleVerb} — ${instance.name}`} onClose={onClose} />

      {started ? (
        <>
          <ModalBody>
            <ProvisionProgress
              instanceId={instance.id}
              kind={started === "live" ? "sync" : "restore"}
              title={`${instance.composeProjectName} · ${instance.server?.name ?? "server"}`}
              onTerminal={(status) => {
                setFinished(status);
                void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
                void queryClient.invalidateQueries({ queryKey: SYNC_SOURCE_QUERY_KEY });
                toast({
                  title: status === "ok" ? (started === "live" ? "Synced" : "Restored") : undefined,
                  message:
                    status === "ok"
                      ? `${instance.name} ${started === "live" ? "synced" : "restored"} — a snapshot of its previous data was kept on the server.`
                      : `${instance.name} ${started === "live" ? "sync" : "restore"} failed — the log is kept on its card.`,
                  variant: status === "ok" ? "success" : "danger",
                });
              }}
            />
            <p className="mt-2.5 text-xs text-neutral-500">
              You can close this — the job continues on the server and the fleet
              card stays live.
            </p>
          </ModalBody>
          <ModalFoot>
            <Button variant={finished === "ok" ? "primary" : "secondary"} onClick={onClose}>
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
              Everything currently in{" "}
              <span className="font-mono text-[12.5px] text-ink">{instance.name}</span>{" "}
              is overwritten. A safety snapshot of the current data is taken
              automatically right before, and kept on the server — but there is
              no one-click undo, so make sure this is the right instance.
            </Alert>

            <div>
              <span className="label-track mb-1.5 block text-neutral-500">Source</span>
              <div className="flex items-center gap-1 rounded-[8px] bg-neutral-100 p-0.5">
                {(
                  [
                    { key: "file" as const, label: "Upload backup file" },
                    { key: "live" as const, label: "Live database" },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setMode(opt.key);
                      setFormError(null);
                    }}
                    className={cn(
                      "flex-1 rounded-[6px] px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400",
                      mode === opt.key
                        ? "bg-white text-ink shadow-sm"
                        : "text-neutral-500 hover:text-ink",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {mode === "file" ? (
              <div>
                <label htmlFor="rb-file" className="label-track mb-1.5 block text-neutral-500">
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
                {fileError ? <p className="mt-1 text-[13px] text-danger">{fileError}</p> : null}
              </div>
            ) : (
              <>
                {stored?.lastSyncedAt ? (
                  <Alert variant={stored.lastSyncStatus === "error" ? "danger" : "info"}>
                    Last synced {formatSyncedAt(stored.lastSyncedAt)}
                    {stored.lastSyncSummary ? ` — ${stored.lastSyncSummary}` : ""}
                  </Alert>
                ) : null}
                <p className="text-xs text-neutral-500">
                  The managed server connects to the source directly and dumps
                  it there — nothing is uploaded through the panel. These
                  details are saved (encrypted) so you can re-sync later without
                  re-entering them.
                </p>
                <SyncSourceForm
                  instanceId={instance.id}
                  state={source}
                  onChange={(next) => {
                    dirty.current = true;
                    setSource(next);
                  }}
                  stored={stored}
                  disabled={pending}
                />
                {sourceError ? (
                  <p className="text-[13px] text-danger">{sourceError}</p>
                ) : null}
              </>
            )}

            <div>
              <label htmlFor="rb-confirm" className="label-track mb-1.5 block text-neutral-500">
                Type{" "}
                <span className="normal-case tracking-normal text-danger">{instance.name}</span>{" "}
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
            <Button variant="secondary" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={!valid || pending}>
              {mode === "file"
                ? restore.isPending
                  ? "Uploading…"
                  : "Restore backup"
                : sync.isPending
                  ? "Starting…"
                  : "Sync from source"}
            </Button>
          </ModalFoot>
        </form>
      )}
    </Dialog>
  );
}
