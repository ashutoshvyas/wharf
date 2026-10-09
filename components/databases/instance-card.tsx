"use client";

/**
 * Instance card (design §5.6 + prototype viewDatabases()).
 *
 * name + StatusBadge / mono `project · server` / the two subdomains as copy
 * MonoFields / created date / status-dependent action row. Role-forbidden
 * actions are HIDDEN, never disabled (design §6).
 *
 * Nothing here flips status optimistically: stop/start show in-button
 * progress and the badge only moves when the server confirms (design §6).
 */
import { Fragment } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Ellipsis,
  Gauge,
  KeyRound,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { formatResourceLimits } from "@/lib/instances/resource-limits";
import { can, type Role } from "@/lib/rbac";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, type DropdownItem } from "@/components/ui/dropdown";
import { MonoField } from "@/components/ui/mono-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import {
  INSTANCES_QUERY_KEY,
  formatDate,
  isTransitional,
  startInstance,
  stopInstance,
  type InstanceDto,
} from "./api";
import { jobKindFor, ProvisionProgress } from "./provision-progress";


export interface InstanceCardProps {
  instance: InstanceDto;
  role: Role;
  onSecrets: () => void;
  onViewLog: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onRestore: () => void;
  onClone: () => void;
  onSslMode: () => void;
  onResourceLimits: () => void;
  /** Opens the full-size progress dialog for this instance. */
  onExpandProgress: () => void;
  /** A progress dialog is already open for this instance — it owns the toast. */
  silentProgress?: boolean;
  layout?: "cards" | "list";
}

export function InstanceCard({
  instance,
  role,
  onSecrets,
  onViewLog,
  onRetry,
  onRemove,
  onRestore,
  onClone,
  onSslMode,
  onResourceLimits,
  onExpandProgress,
  silentProgress = false,
  layout = "cards",
}: InstanceCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();

  const canStopStart = can(role, "instance.stopstart");
  const canRetry = can(role, "instance.retry");
  const canRemove = can(role, "instance.remove");
  const canRestore = can(role, "instance.restore");
  const canChangeSslMode = can(role, "instance.ssl-mode.write");
  const canChangeLimits = can(role, "instance.resource-limits.write");
  const canReveal = can(role, "secrets.reveal");

  const busy = isTransitional(instance.status);
  const isError = instance.status === "error";

  const power = useMutation({
    mutationFn: (action: "stop" | "start") =>
      action === "stop" ? stopInstance(instance.id) : startInstance(instance.id),
    onSuccess: (_data, action) => {
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
      toast({
        message:
          action === "stop"
            ? `${instance.name} stopped — volumes intact, subdomains quiet until restart.`
            : `${instance.name} started — Traefik routes restored.`,
        variant: "success",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Action failed", message: err.message, variant: "danger" });
      void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
    },
  });

  const menuItems: DropdownItem[] = [
    {
      label: "Network access…",
      icon: <ShieldCheck size={15} strokeWidth={1.75} />,
      onSelect: () => router.push(`/databases/${instance.id}/network-access`),
    },
    ...(canReveal
      ? [
        {
          label: "Connection & secrets",
          icon: <KeyRound size={15} strokeWidth={1.75} />,
          onSelect: onSecrets,
        } satisfies DropdownItem,
      ]
      : []),
    ...(canChangeSslMode
      ? [
        {
          label: "Change SSL mode…",
          icon: <ShieldCheck size={15} strokeWidth={1.75} />,
          onSelect: onSslMode,
        } satisfies DropdownItem,
      ]
      : []),
    ...(canChangeLimits
      ? [
        {
          label: "Resource limits…",
          icon: <Gauge size={15} strokeWidth={1.75} />,
          onSelect: onResourceLimits,
        } satisfies DropdownItem,
      ]
      : []),
    {
      label: "View last log",
      icon: <ScrollText size={15} strokeWidth={1.75} />,
      onSelect: onViewLog,
    },
    ...(isError && canRetry
      ? [
        {
          label: "Retry provisioning",
          icon: <RotateCcw size={15} strokeWidth={1.75} />,
          onSelect: onRetry,
        } satisfies DropdownItem,
      ]
      : []),
    ...(instance.status === "running" && canRestore
      ? [
        {
          label: "Clone database…",
          icon: <Copy size={15} strokeWidth={1.75} />,
          onSelect: onClone,
        } satisfies DropdownItem,
        {
          label: "Restore / Sync…",
          icon: <Upload size={15} strokeWidth={1.75} />,
          onSelect: onRestore,
        } satisfies DropdownItem,
      ]
      : []),
    ...(canRemove
      ? [
        { type: "separator" as const },
        {
          label: "Remove permanently…",
          icon: <Trash2 size={15} strokeWidth={1.75} />,
          danger: true,
          onSelect: onRemove,
        } satisfies DropdownItem,
      ]
      : []),
  ];

  const serverName = instance.server?.name ?? "unknown server";

  const controls = busy ? (
    <ProvisionProgress
      instanceId={instance.id}
      kind={jobKindFor(instance)}
      title={`${instance.composeProjectName} · ${serverName}`}
      compact
      onExpand={onExpandProgress}
      onTerminal={(status) => {
        void queryClient.invalidateQueries({ queryKey: INSTANCES_QUERY_KEY });
        // A successful provision may have just prepared the server for
        // the first time (architecture §4.1) — refresh its cached query
        // too, or its detail page (and the "Re-run setup" button) stays
        // stale until something unrelated triggers a refetch. Restore
        // never touches bootstrap state, so it doesn't need this.
        if (instance.status === "provisioning" && status === "ok") {
          void queryClient.invalidateQueries({ queryKey: ["server", instance.serverId] });
          void queryClient.invalidateQueries({ queryKey: ["servers"] });
        }
        if (silentProgress) return;
        if (instance.status === "removing") {
          toast({
            message:
              status === "ok"
                ? `${instance.name} removed — volumes destroyed.`
                : `${instance.name} could not be removed — see log.`,
            variant: status === "ok" ? "info" : "danger",
          });
        } else if (instance.status === "restoring") {
          const verb = instance.activeJob === "clone" ? "clone" : instance.activeJob === "sync" ? "sync" : "restore";
          const completed = verb === "clone" ? "cloned" : verb === "sync" ? "synced" : "restored";
          toast({
            title: status === "ok" ? (verb === "clone" ? "Database cloned" : verb === "sync" ? "Synced" : "Restored") : undefined,
            message:
              status === "ok"
                ? `${instance.name} ${completed} — a snapshot of its previous data was kept on the server.`
                : `${instance.name} ${verb} failed — see log.`,
            variant: status === "ok" ? "success" : "danger",
          });
        } else {
          toast({
            title: status === "ok" ? "Provisioned" : undefined,
            message:
              status === "ok"
                ? `${instance.name} is running.`
                : `${instance.name} failed to provision — see log.`,
            variant: status === "ok" ? "success" : "danger",
          });
        }
      }}
    />
  ) : (
    <div className="mt-auto flex flex-wrap items-center gap-2">
      {instance.status === "running" ? (
        <ButtonLink
          href={`/databases/${instance.id}/manage`}
          variant="primary"
          size="sm"
        >
          Manage
        </ButtonLink>
      ) : null}
      {instance.status === "running" && canStopStart ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={power.isPending}
          onClick={() => power.mutate("stop")}
        >
          {power.isPending ? "Stopping…" : "Stop"}
        </Button>
      ) : null}
      {instance.status === "stopped" && canStopStart ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={power.isPending}
          onClick={() => power.mutate("start")}
        >
          {power.isPending ? "Starting…" : "Start"}
        </Button>
      ) : null}
      {isError && canRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
          Retry
        </Button>
      ) : null}
      <span className="flex-1" />
      <DropdownMenu
        align="end"
        trigger={
          <button
            type="button"
            aria-label={`Actions for ${instance.name}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-neutral-400 transition-colors hover:bg-cobalt-50 hover:text-cobalt-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
          >
            <Ellipsis size={16} strokeWidth={1.75} />
          </button>
        }
        items={menuItems}
      />
    </div>
  );

  if (layout === "list") {
    const cell = "border-b border-neutral-100 px-4 py-3 align-middle text-sm";
    return (
      <Fragment>
        <tr className="hover:bg-neutral-50">
          <td className={cell}>
            <div className="min-w-36 font-semibold">{instance.name}</div>
            <div className="mt-1 font-mono text-xs text-neutral-500">{instance.composeProjectName}</div>
          </td>
          <td className={cell}>
            <Link href={`/servers/${instance.serverId}`} className="text-cobalt-600 hover:underline">{serverName}</Link>
            <div className="mt-1 whitespace-nowrap font-mono text-xs text-neutral-500">{instance.server?.host ?? "—"}</div>
          </td>
          <td className={cell}>
            <div className="min-w-44 max-w-64 space-y-1">
              <MonoField value={instance.apiSubdomain} />
              <MonoField value={instance.studioSubdomain} />
            </div>
          </td>
          <td className={cell}>
            <StatusBadge status={instance.status} />
            {isError && <button type="button" className="mt-1 block text-xs text-danger underline" onClick={onViewLog}>View log</button>}
          </td>
          <td className={cell}><span className="whitespace-nowrap text-xs">{instance.sslMode === "require" ? "Required" : "Not enforced"}</span></td>
          <td className={cell}><span className="whitespace-nowrap text-xs text-neutral-500">{formatDate(instance.createdAt)}</span></td>
          <td className={cell}>
            {busy ? <Button variant="secondary" size="sm" onClick={onExpandProgress}>View progress</Button> : controls}
          </td>
        </tr>
        {busy && <tr><td colSpan={7} className="border-b border-neutral-100 bg-neutral-50 px-4 py-3">{controls}</td></tr>}
      </Fragment>
    );
  }

  return (
    <Card glow={busy} hoverable={!busy} className="flex flex-col p-5">
      <div className="mb-2 flex items-center justify-between gap-2.5">
        <span className="truncate text-base font-semibold text-ink">
          {instance.name}
        </span>
        <StatusBadge status={instance.status} />
      </div>

      <div className="mb-3 truncate font-mono text-[12px] text-neutral-500">
        {instance.composeProjectName} ·{" "}
        <Link
          href={`/servers/${instance.serverId}`}
          className="text-neutral-500 underline-offset-2 hover:text-cobalt-600 hover:underline"
        >
          {serverName}{instance.server?.host ? ` · ${instance.server.host}` : ""}
        </Link>
      </div>

      <div className="mb-3 flex flex-col gap-1.5">
        <MonoField value={instance.apiSubdomain} />
        <MonoField value={instance.studioSubdomain} />
      </div>

      <div className="mb-3.5 text-[12.5px] text-neutral-400">
        {instance.sslMode === "require" ? "TLS required" : "TLS not enforced"} ·{" "}
        {instance.resourceLimitsAppliedAt
          ? formatResourceLimits(instance)
          : <span className="text-warning">limits not applied</span>}{" "}
        · created {formatDate(instance.createdAt)}
      </div>

      {isError ? (
        <Alert variant="danger" className="mb-3 px-3 py-2.5">
          <b className="font-semibold">Provisioning failed.</b>{" "}
          <button
            type="button"
            onClick={onViewLog}
            className="underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
          >
            View log tail
          </button>
          {canRetry ? (
            <>
              {" · "}
              <button
                type="button"
                onClick={onRetry}
                className="underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt-400"
              >
                Retry
              </button>
            </>
          ) : null}
        </Alert>
      ) : null}

      {controls}

    </Card>
  );
}
