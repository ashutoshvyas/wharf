/**
 * Per-instance CPU/memory budget — the server side of
 * lib/instances/resource-limits.ts.
 *
 * Each instance owns one systemd slice, `wharf-<project>.slice`, and every
 * one of its containers is created inside it (render.ts emits
 * `cgroup_parent`). The slice's CPUQuota/MemoryHigh/MemoryMax then bound the
 * whole stack together. The limits live in two places on the server:
 *
 *   - /etc/systemd/system/<slice> — the persistent definition, survives reboot;
 *   - `systemctl set-property --runtime` — applies the same values to the
 *     live slice immediately, without restarting a single container.
 *
 * Changing a budget is therefore instant. Only the FIRST apply on an instance
 * created before this feature restarts anything: its containers were created
 * outside the slice, and Docker fixes a container's cgroup at creation, so
 * they are recreated once with `up -d` (about a minute of downtime).
 *
 * Requires Docker's systemd cgroup driver on cgroup v2 — the default for
 * get.docker.com on any current systemd distribution. Anything else is
 * reported as unsupported rather than silently left unlimited.
 */
import type { DbInstance } from "@prisma/client";
import { open } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { INSTANCE_INCLUDE, type DbInstanceRecord } from "@/lib/instances/serialize";
import {
  instanceSliceName,
  sliceProperties,
  type ResourceLimits,
} from "@/lib/instances/resource-limits";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { exec, sftpWrite, withConnection } from "@/lib/ssh";
import { decryptAuthSettings } from "./auth-settings";
import { EMAIL_TEMPLATE_FLOWS, renderInstanceCompose } from "./render";
import { shellQuote } from "./restore-core";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

/** Recreating a whole stack restarts ~9 containers; images are already local. */
const RECREATE_TIMEOUT_MS = 300_000;

export function sliceUnitPath(project: string): string {
  return `/etc/systemd/system/${instanceSliceName(project)}`;
}

/** The persistent unit file. Pure, so its exact bytes are unit-tested. */
export function sliceUnitFile(project: string, limits: ResourceLimits): string {
  return [
    "# Managed by WHARF (lib/provision/resource-limits.ts) — do not edit.",
    "[Unit]",
    `Description=WHARF instance ${project}`,
    "",
    "[Slice]",
    "CPUAccounting=yes",
    "MemoryAccounting=yes",
    ...sliceProperties(limits).filter((p) => p !== "CPUQuota="),
    "",
  ].join("\n");
}

/**
 * Throw a readable error unless Docker uses the systemd cgroup driver on
 * cgroup v2 — the only setup where `cgroup_parent: <name>.slice` attaches
 * containers to a slice systemd enforces limits on.
 */
export async function assertSliceSupport(conn: SshConnection): Promise<void> {
  const res = await exec(
    conn,
    "docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}'",
  );
  const [driver, version] = res.stdout.trim().split(/\s+/);
  if (res.code !== 0 || driver !== "systemd" || version !== "2") {
    throw new Error(
      `Per-instance limits need Docker's systemd cgroup driver on cgroup v2; this server reports ` +
        `${res.code === 0 ? `driver=${driver ?? "?"} cgroup=v${version ?? "?"}` : `an error (${res.stderr.trim()})`}.`,
    );
  }
}

/**
 * Write the slice unit and apply its limits to the live slice. Idempotent;
 * never touches a container.
 */
export async function installInstanceSlice(
  conn: SshConnection,
  project: string,
  limits: ResourceLimits,
): Promise<void> {
  await assertSliceSupport(conn);
  const slice = instanceSliceName(project);
  await sftpWrite(conn, sliceUnitPath(project), sliceUnitFile(project, limits), 0o644);
  const props = sliceProperties(limits).map(shellQuote).join(" ");
  const res = await exec(
    conn,
    `systemctl daemon-reload && systemctl set-property --runtime ${slice} ${props}`,
  );
  if (res.code !== 0) {
    throw new Error(`Could not apply limits to ${slice} (code ${res.code}): ${res.stderr.trim()}`);
  }
}

/** Remove the slice's unit file and runtime drop-ins. Best-effort, for teardown. */
export async function removeInstanceSlice(conn: SshConnection, project: string): Promise<void> {
  const slice = instanceSliceName(project);
  await exec(
    conn,
    `rm -f ${sliceUnitPath(project)} && rm -rf /run/systemd/system.control/${slice}.d && systemctl daemon-reload`,
  );
}

/** How many of the project's containers (running or not) sit outside its slice. */
export async function containersOutsideSlice(conn: SshConnection, project: string): Promise<number> {
  const res = await exec(
    conn,
    `docker ps -aq --filter label=com.docker.compose.project=${project} | ` +
      // Prefixed: a container outside any slice has an EMPTY CgroupParent,
      // which must still count as a line.
      `xargs -r docker inspect --format 'parent={{.HostConfig.CgroupParent}}'`,
  );
  if (res.code !== 0) {
    throw new Error(`Could not inspect ${project}'s containers: ${res.stderr.trim()}`);
  }
  const inSlice = `parent=${instanceSliceName(project)}`;
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("parent=") && line !== inSlice).length;
}

type InstanceWithSettings = DbInstance & {
  authSettings: Parameters<typeof decryptAuthSettings>[0];
  emailTemplates: { flow: string; subject: string | null; bodyHtml: string | null }[];
  analyticsSettings: { enabled: boolean } | null;
};

/**
 * Re-render from EVERYTHING stored for the instance — auth settings, email
 * templates and the analytics toggle. A partial input would silently reset
 * whichever settings it left out, and `up -d` would push that to the server.
 */
async function renderFromStoredSettings(instance: InstanceWithSettings) {
  const byFlow = new Map(instance.emailTemplates.map((t) => [t.flow, t]));
  return renderInstanceCompose({
    slug: instance.slug,
    project: instance.composeProjectName,
    domain: process.env.INSTANCE_DOMAIN ?? "",
    secrets: {
      pgPassword: open(instance.pgPasswordEnc!),
      jwtSecret: open(instance.jwtSecretEnc!),
      anonKey: open(instance.anonKeyEnc!),
      serviceRoleKey: open(instance.serviceRoleKeyEnc!),
    },
    remotePath: instance.remotePath,
    authSettings: decryptAuthSettings(instance.authSettings),
    emailTemplates: EMAIL_TEMPLATE_FLOWS.map((flow) => {
      const row = byFlow.get(flow);
      return { flow, subject: row?.subject ?? "", hasBody: !!row?.bodyHtml };
    }),
    analyticsSettings: { enabled: instance.analyticsSettings?.enabled ?? false },
    instanceId: instance.id,
    panelUrl: process.env.PANEL_URL,
  });
}

export type ApplyResourceLimitsResult =
  | { ok: true; instance: DbInstanceRecord; recreated: boolean }
  | { notFound: true }
  | { busy: string }
  | { invalid: string };

/**
 * Save and apply an instance's budget. The requested limits are persisted
 * even when applying fails, with the failure in `resourceLimitsError` and
 * `resourceLimitsAppliedAt` cleared — the panel shows "not applied" rather
 * than losing the operator's input (same model as network access).
 */
export async function applyResourceLimits(
  instanceId: string,
  limits: ResourceLimits,
): Promise<ApplyResourceLimitsResult> {
  const instance = await prisma.dbInstance.findFirst({
    where: { id: instanceId, deletedAt: null },
    include: { authSettings: true, emailTemplates: true, analyticsSettings: true },
  });
  if (!instance) return { notFound: true };
  if (
    !instance.pgPasswordEnc ||
    !instance.jwtSecretEnc ||
    !instance.anonKeyEnc ||
    !instance.serviceRoleKeyEnc
  ) {
    return { invalid: "This instance has no stored secrets yet — finish or retry provisioning first." };
  }
  if (instance.status !== "running" && instance.status !== "stopped") {
    return { invalid: `This instance is ${instance.status} — wait until it is running or stopped.` };
  }

  const release = tryAcquireServerLock(instance.serverId, "resource-limits");
  if (!release) return { busy: serverLockHolder(instance.serverId) ?? "another job" };

  try {
    let recreated = false;
    try {
      await withConnection(instance.serverId, async (conn: SshConnection) => {
        const project = instance.composeProjectName;
        const outside = await containersOutsideSlice(conn, project);
        // `docker compose start` reuses existing containers, so a stopped
        // instance would come back outside the slice — and recreating it
        // here would start it. Refuse instead of doing either silently.
        if (outside > 0 && instance.status === "stopped") {
          throw new InvalidRequest(
            "This instance's containers predate per-instance limits. Start it first — " +
              "applying will then recreate them inside the instance's slice.",
          );
        }
        await installInstanceSlice(conn, project, limits);
        if (outside === 0) return;

        const { composeYaml, envFile } = await renderFromStoredSettings(instance);
        await sftpWrite(conn, `${instance.remotePath}/docker-compose.yml`, composeYaml);
        await sftpWrite(conn, `${instance.remotePath}/.env`, envFile, 0o600);
        const up = await exec(
          conn,
          `cd ${instance.remotePath} && docker compose -p ${project} up -d`,
          { timeoutMs: RECREATE_TIMEOUT_MS },
        );
        if (up.code !== 0) {
          throw new Error(`docker compose up -d failed (code ${up.code}): ${up.stderr.trim()}`);
        }
        recreated = true;
        const stillOutside = await containersOutsideSlice(conn, project);
        if (stillOutside > 0) {
          throw new Error(`${stillOutside} container(s) are still outside ${instanceSliceName(project)} after recreating.`);
        }
      });
    } catch (err) {
      if (err instanceof InvalidRequest) return { invalid: err.message };
      await prisma.dbInstance.update({
        where: { id: instance.id },
        data: {
          ...limits,
          resourceLimitsAppliedAt: null,
          resourceLimitsError: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }

    const updated = await prisma.dbInstance.update({
      where: { id: instance.id },
      data: { ...limits, resourceLimitsAppliedAt: new Date(), resourceLimitsError: null },
      include: INSTANCE_INCLUDE,
    });
    return { ok: true, instance: updated, recreated };
  } finally {
    release();
  }
}

/** A refusal decided on the server's state — maps to 409, never persisted as an error. */
class InvalidRequest extends Error {}
