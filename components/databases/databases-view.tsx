"use client";

/**
 * Databases — fleet dashboard (/069/070/071, design §5.6/§5.7/§5.9).
 *
 * Card grid of every instance in the fleet. Polling is server-confirmed only:
 * 5s while ANY instance is transitional, 30s otherwise (design §6). Nothing in
 * this view flips a status locally — the engine owns `status`, the UI renders
 * it (contract §2).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Plus } from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { Dialog, ModalBody, ModalFoot, ModalHead } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionLabel } from "@/components/ui/section-label";
import { useToast } from "@/components/ui/toast";
import {
  ApiError,
  INSTANCES_QUERY_KEY,
  fetchInstances,
  isTransitional,
  removeInstance,
  retryInstance,
  type InstanceDto,
} from "./api";
import { InstanceCard } from "./instance-card";
import { CloneDatabaseModal } from "./clone-database-modal";
import { LogTailModal } from "./log-tail-modal";
import { NewInstanceModal } from "./new-instance-modal";
import { jobKindFor, ProvisionProgress, type JobKind } from "./provision-progress";
import { RestoreBackupModal } from "./restore-backup-modal";
import { SecretsModal } from "./secrets-modal";
import { SslModeModal } from "./ssl-mode-modal";

const POLL_TRANSITIONAL_MS = 5_000;
const POLL_IDLE_MS = 30_000;

export function DatabasesView({
  role,
  domain,
}: {
  role: Role;
  /** INSTANCE_DOMAIN, resolved server-side and threaded down (never NEXT_PUBLIC). */
  domain: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const canProvision = can(role, "instance.provision");
  const canRetry = can(role, "instance.retry");
  const canRemove = can(role, "instance.remove");
  const canRestore = can(role, "instance.restore");

  const [newOpen, setNewOpen] = useState(false);
  const [secretsFor, setSecretsFor] = useState<InstanceDto | null>(null);
  const [logFor, setLogFor] = useState<InstanceDto | null>(null);
  const [removeFor, setRemoveFor] = useState<InstanceDto | null>(null);
  const [forceRemove, setForceRemove] = useState(false);
  const [restoreFor, setRestoreFor] = useState<InstanceDto | null>(null);
  const [cloneFor, setCloneFor] = useState<InstanceDto | null>(null);
  const [modalCloningId, setModalCloningId] = useState<string | null>(null);
  const [sslModeFor, setSslModeFor] = useState<InstanceDto | null>(null);
  /**
   * The dialog's job kind is tracked explicitly here rather than derived from
   * `instance.status` — a mutation's `onSuccess` only ever sees the row as it
   * was *before* that call (retry/remove's own `variables`), never "removing"
   * or "provisioning" yet, so inferring the kind from that stale snapshot
   * always guessed "provision" (see jobKindFor's doc comment).
   */
  const [progress, setProgress] = useState<{ instance: InstanceDto; kind: JobKind } | null>(
    null,
  );
  /** Instance the new-instance modal is currently streaming. */
  const [modalProvisioningId, setModalProvisioningId] = useState<string | null>(null);

  const instances = useQuery({
    queryKey: INSTANCES_QUERY_KEY,
    queryFn: () => fetchInstances(),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.some((i) => isTransitional(i.status))
        ? POLL_TRANSITIONAL_MS
        : POLL_IDLE_MS;
    },
  });

  const rows = instances.data ?? [];

  const retry = useMutation({
    mutationFn: (instance: InstanceDto) => retryInstance(instance.id),
    onSuccess: (_data, instance) => {
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
      setProgress({ instance, kind: "provision" });
    },
    onError: (err: Error) => {
      toast({
        title: err instanceof ApiError && err.status === 409 ? "Server busy" : "Retry failed",
        message: err.message,
        variant: err instanceof ApiError && err.status === 409 ? "warning" : "danger",
      });
    },
  });

  const remove = useMutation({
    mutationFn: (vars: { instance: InstanceDto; force: boolean }) =>
      removeInstance(vars.instance.id, vars.instance.name, vars.force),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
      setRemoveFor(null);
      setProgress({ instance: vars.instance, kind: "remove" });
    },
    onError: (err: Error) => {
      toast({ title: "Removal failed to start", message: err.message, variant: "danger" });
      setRemoveFor(null);
    },
  });

  /** The card must not double-toast a stream a dialog is already narrating. */
  function isSilent(instance: InstanceDto): boolean {
    return (
      progress?.instance.id === instance.id ||
      modalProvisioningId === instance.id ||
      restoreFor?.id === instance.id ||
      modalCloningId === instance.id
    );
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Supabase fleet</SectionLabel>
          <h2 className="mt-1 text-[26px] font-bold tracking-tight">Databases</h2>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            Provision, manage and destroy isolated Supabase stacks. Each gets two
            subdomains — API (public) and Studio (panel-gated).
          </p>
        </div>
        {canProvision ? (
          <Button variant="accent" onClick={() => setNewOpen(true)}>
            <Plus size={16} strokeWidth={2} aria-hidden />
            New instance
          </Button>
        ) : null}
      </div>

      {instances.isError ? (
        <Alert variant="danger" title="Could not load instances">
          <p>{instances.error.message}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2.5"
            onClick={() => void instances.refetch()}
          >
            Retry
          </Button>
        </Alert>
      ) : instances.isPending ? (
        <Card>
          <p className="px-5 py-10 text-center text-[13px] text-neutral-500">
            Loading instances…
          </p>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Database}
            message="No database instances yet — provision your first Supabase stack."
            action={
              canProvision ? (
                <Button variant="accent" size="sm" onClick={() => setNewOpen(true)}>
                  New instance
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(330px,1fr))]">
          {rows.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              role={role}
              silentProgress={isSilent(instance)}
              onSecrets={() => setSecretsFor(instance)}
              onViewLog={() => setLogFor(instance)}
              onRetry={() => {
                if (canRetry) retry.mutate(instance);
              }}
              onRemove={() => {
                if (canRemove) setRemoveFor(instance);
              }}
              onRestore={() => {
                if (canRestore) setRestoreFor(instance);
              }}
              onClone={() => {
                if (canRestore) setCloneFor(instance);
              }}
              onSslMode={() => setSslModeFor(instance)}
              onExpandProgress={() => setProgress({ instance, kind: jobKindFor(instance) })}
            />
          ))}
        </div>
      )}

      <NewInstanceModal
        open={newOpen}
        domain={domain}
        onProvisioning={setModalProvisioningId}
        onClose={() => {
          setNewOpen(false);
          setModalProvisioningId(null);
        }}
      />

      <SecretsModal
        open={secretsFor !== null}
        onClose={() => setSecretsFor(null)}
        instance={secretsFor}
      />

      <SslModeModal
        open={sslModeFor !== null}
        onClose={() => setSslModeFor(null)}
        instance={sslModeFor}
      />

      <LogTailModal
        open={logFor !== null}
        onClose={() => setLogFor(null)}
        instance={logFor}
      />

      <ProgressDialog
        progress={progress}
        onClose={() => setProgress(null)}
        onTerminal={(instance, kind, status) => {
          void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
          // A successful provision may have just prepared the server for the
          // first time (architecture §4.1 — bootstrapped flips true on first
          // instance). Without this, the server's own cached query (its
          // detail page, the "Re-run setup" button's visibility) stays stale
          // until something unrelated happens to refetch it. Remove/restore/
          // sync never touch bootstrap state, so they don't need this.
          if (kind === "provision" && status === "ok") {
            void queryClient.invalidateQueries({ queryKey: ["server", instance.serverId] });
            void queryClient.invalidateQueries({ queryKey: ["servers"] });
          }
          if (kind === "remove") {
            toast({
              message:
                status === "ok"
                  ? `${instance.name} removed — volumes destroyed.`
                  : `${instance.name} could not be removed — see log.`,
              variant: status === "ok" ? "info" : "danger",
            });
          } else if (kind === "restore" || kind === "sync" || kind === "clone") {
            const verb = kind === "clone" ? "cloned" : kind === "sync" ? "synced" : "restored";
            toast({
              title: status === "ok" ? (kind === "clone" ? "Database cloned" : kind === "sync" ? "Synced" : "Restored") : undefined,
              message:
                status === "ok"
                  ? `${instance.name} ${verb} — a snapshot of its previous data was kept on the server.`
                  : `${instance.name} ${kind} failed — see log.`,
              variant: status === "ok" ? "success" : "danger",
            });
          } else {
            toast({
              title: status === "ok" ? "Provisioned" : undefined,
              message:
                status === "ok"
                  ? `${instance.name} is running.`
                  : `${instance.name} failed — the log is kept on its card.`,
              variant: status === "ok" ? "success" : "danger",
            });
          }
        }}
      />

      <ConfirmModal
        open={removeFor !== null}
        onClose={() => setRemoveFor(null)}
        title="Remove permanently"
        variant="danger"
        confirmLabel={forceRemove ? "Force remove" : "Remove instance"}
        typeToConfirm={removeFor?.name}
        requireAck={
          removeFor?.status === "error"
            ? "Remove WHARF's record regardless of whether the server can be reached — WHARF still tries to stop containers and delete volumes/files there first, but a connection failure won't block the removal."
            : undefined
        }
        onAckChange={setForceRemove}
        busy={remove.isPending}
        onConfirm={() => {
          if (removeFor) remove.mutate({ instance: removeFor, force: forceRemove });
        }}
      >
        {forceRemove ? (
          <p>
            Remove WHARF&apos;s record of{" "}
            <span className="font-mono text-[12.5px] text-ink">{removeFor?.name}</span>{" "}
            <b className="text-danger">even if its server can&apos;t be reached.</b>{" "}
            WHARF still attempts the same cleanup as a normal remove (containers,
            volumes, files); if that fails or the server is unreachable, only
            WHARF&apos;s own record is removed and anything left on the server
            stays exactly as it is.
          </p>
        ) : (
          <>
            <p>
              Delete the containers and <b>all data volumes</b> for{" "}
              <span className="font-mono text-[12.5px] text-ink">{removeFor?.name}</span>{" "}
              on {removeFor?.server?.name ?? "its server"}.
            </p>
            <p className="mt-2">
              The metadata record is soft-deleted and recoverable for a grace period
              — <b className="text-danger">the database volumes are destroyed
              immediately and permanently.</b>{" "}
              That data cannot be recovered. Linked websites keep their record with
              the database link cleared.
            </p>
          </>
        )}
      </ConfirmModal>

      <RestoreBackupModal
        open={restoreFor !== null}
        onClose={() => setRestoreFor(null)}
        instance={restoreFor}
      />

      {cloneFor ? (
        <CloneDatabaseModal
          key={cloneFor.id}
          source={cloneFor}
          instances={rows}
          onCloning={setModalCloningId}
          onClose={() => {
            setCloneFor(null);
            setModalCloningId(null);
          }}
          onNewInstance={() => {
            setCloneFor(null);
            setNewOpen(true);
          }}
        />
      ) : null}
    </div>
  );
}

const PROGRESS_DIALOG_TITLE: Record<JobKind, string> = {
  provision: "Provisioning",
  remove: "Removing",
  restore: "Restoring",
  sync: "Syncing",
  clone: "Cloning",
};

/**
 * Full-size progress view for a stream that started outside the new-instance
 * modal — a retry, a teardown, or a card the operator expanded. `kind` is
 * decided by the caller (never derived here from `instance.status`, which —
 * for a mutation's just-kicked-off job — is still the value from BEFORE that
 * call; see the `progress` state's doc comment above).
 */
function ProgressDialog({
  progress,
  onClose,
  onTerminal,
}: {
  progress: { instance: InstanceDto; kind: JobKind } | null;
  onClose: () => void;
  onTerminal: (instance: InstanceDto, kind: JobKind, status: "ok" | "error") => void;
}) {
  if (!progress) return null;
  const { instance, kind } = progress;
  return (
    <Dialog open onClose={onClose} wide>
      <ModalHead
        title={`${PROGRESS_DIALOG_TITLE[kind]} — ${instance.name}`}
        onClose={onClose}
      />
      <ModalBody>
        <ProvisionProgress
          instanceId={instance.id}
          kind={kind}
          title={`${instance.composeProjectName} · ${instance.server?.name ?? "server"}`}
          onTerminal={(status) => onTerminal(instance, kind, status)}
        />
        <p className="mt-2.5 text-xs text-neutral-500">
          You can close this — the operation continues on the server and the
          fleet card stays live.
        </p>
      </ModalBody>
      <ModalFoot>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFoot>
    </Dialog>
  );
}
