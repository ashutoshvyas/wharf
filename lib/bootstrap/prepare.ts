/**
 * Lazy server preparation + preflight — architecture §4.1
 * "Bootstrap — when it runs" and docs/provisioning-contract.md §6.
 *
 * Servers are never prepared up-front. The first time a database instance is
 * provisioned onto a server, the provisioning pipeline calls
 * {@link ensureServerPrepared} as its `prepare` phase: preflight first (so a
 * host that can never work as a database server is rejected **before** it is
 * modified), then the ordinary idempotent bootstrap steps.
 *
 * Everything here takes an ALREADY-OPEN connection and assumes the caller
 * holds the per-server lock and owns the job stream — provisioning therefore
 * uses one connection, one lock and one log for prepare + provision.
 *
 * The standalone bootstrap route (lib/bootstrap/run.ts) reuses the same step
 * loop via {@link runBootstrapSteps} but keeps its own phase-free line format.
 */
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { exec } from "@/lib/ssh";
import { BOOTSTRAP_STEPS, type EmitFn } from "./steps";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

/** Minimum free space on /opt before we will install anything (bytes → KB). */
export const MIN_FREE_KB = 10 * 1024 * 1024; // 10 GB in 1K blocks

/** Ports a database server must own outright (Traefik binds them). */
const REQUIRED_PORTS = [80, 443] as const;

/**
 * Run the five idempotent bootstrap steps over an open connection, publishing
 * `› name` / `✓ name` markers through `emit`.
 *
 * This is the exact loop lib/bootstrap/run.ts used to inline: the standalone
 * route passes a raw emit (so the markers are real `step`/`ok` events), while
 * the provisioning pipeline passes an emit that downgrades everything to
 * `info` so the whole of preparation reads as ONE `prepare` phase in the UI
 * checklist (provisioning-contract §5).
 */
export async function runBootstrapSteps(
  conn: SshConnection,
  emit: EmitFn,
): Promise<void> {
  for (const step of BOOTSTRAP_STEPS) {
    emit("step", `› ${step.name}`);
    if (await step.check(conn, emit)) {
      emit("ok", `✓ ${step.name}: already done — skipped`);
      continue;
    }
    await step.apply(conn, emit);
    emit("ok", `✓ ${step.name}`);
  }
}

/** Tolerant exec: a transport-level failure becomes a non-zero result. */
async function tryExec(
  conn: SshConnection,
  cmd: string,
  timeoutMs = 15_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  try {
    return await exec(conn, cmd, { timeoutMs });
  } catch (err) {
    return {
      code: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Parse `ss -ltn(p)` / `netstat -ltn(p)` output for a listener on `port`.
 * Both tools print the local address as a `host:port` token; the peer column
 * is always `*:*`/`0.0.0.0:*`, so a token ending in `:{port}` is unambiguous.
 * Returns the owning process name when `-p` gave us one.
 */
export function findListener(
  output: string,
  port: number,
): { found: boolean; process?: string } {
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || /^(State|Active|Proto)\b/i.test(line)) continue;
    const listens = line
      .split(/\s+/)
      .some((token) => new RegExp(`(^|[:.])${port}$`).test(token) && token.includes(":"));
    if (!listens) continue;
    // ss -ltnp: users:(("nginx",pid=812,fd=6))   |   netstat -ltnp: 812/nginx
    const ssProc = /users:\(\("([^"]+)"/.exec(line);
    const netstatProc = /\s\d+\/(\S+)\s*$/.exec(line);
    const proc = ssProc?.[1] ?? netstatProc?.[1];
    return proc ? { found: true, process: proc } : { found: true };
  }
  return { found: false };
}

/** Parse the `df -P` data line and return available 1K blocks, or null. */
export function parseDfAvailableKb(output: string): number | null {
  const line = output.trim().split("\n").pop()?.trim();
  if (!line) return null;
  const fields = line.split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity Mounted-on
  const available = Number(fields[3]);
  return Number.isFinite(available) ? available : null;
}

function formatGb(kb: number): string {
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Preflight a server that is about to be prepared (provisioning-contract §6).
 * Throws with an actionable message; runs BEFORE anything is installed or
 * written, so a rejected host is left completely untouched.
 *
 *  1. ports 80/443 free   2. effective root   3. ≥10 GB free on /opt
 */
export async function preflightServer(
  conn: SshConnection,
  emit: EmitFn,
): Promise<void> {
  // ── 1. ports 80/443 free ────────────────────────────────────────────────
  // Prefer `ss -ltnp` (gives the owning process); fall back through plain ss
  // to netstat for hosts without iproute2.
  let listeners = await tryExec(conn, "ss -ltnp");
  if (listeners.code !== 0 || !listeners.stdout.trim()) {
    listeners = await tryExec(conn, "ss -ltn");
  }
  if (listeners.code !== 0 || !listeners.stdout.trim()) {
    listeners = await tryExec(conn, "netstat -ltnp");
  }
  if (listeners.code !== 0 || !listeners.stdout.trim()) {
    listeners = await tryExec(conn, "netstat -ltn");
  }
  if (listeners.code !== 0) {
    throw new Error(
      "preflight: could not list listening sockets (`ss -ltn` and `netstat -ltn` both failed) — " +
        "install iproute2 or net-tools on the server and retry.",
    );
  }
  for (const port of REQUIRED_PORTS) {
    const hit = findListener(listeners.stdout, port);
    if (hit.found) {
      throw new Error(
        `port ${port} is in use${hit.process ? ` by ${hit.process}` : ""} — ` +
          "a database server must own ports 80 and 443 " +
          "(see architecture open question §5). Use a dedicated server for databases.",
      );
    }
  }
  emit("info", "preflight: ports 80 and 443 are free");

  // ── 2. effective root ───────────────────────────────────────────────────
  const uid = await tryExec(conn, "id -u");
  const isRoot = uid.code === 0 && uid.stdout.trim() === "0";
  if (!isRoot) {
    const sudo = await tryExec(conn, "sudo -n true");
    if (sudo.code !== 0) {
      throw new Error(
        "the SSH user is not root and passwordless sudo is unavailable " +
          "(`sudo -n true` failed) — preparing a database server installs Docker and " +
          "binds ports 80/443. Connect as root, or grant this user NOPASSWD sudo.",
      );
    }
    emit("info", "preflight: not root, but passwordless sudo works");
  } else {
    emit("info", "preflight: running as root");
  }

  // ── 3. disk ─────────────────────────────────────────────────────────────
  const df = await tryExec(conn, "df -P /opt | tail -1");
  if (df.code !== 0) {
    throw new Error(
      `preflight: could not read free space on /opt (\`df -P /opt\` exited ${df.code}): ${df.stderr.trim()}`,
    );
  }
  const availableKb = parseDfAvailableKb(df.stdout);
  if (availableKb === null) {
    throw new Error(
      `preflight: could not parse \`df -P /opt\` output: ${df.stdout.trim()}`,
    );
  }
  if (availableKb < MIN_FREE_KB) {
    throw new Error(
      `only ${formatGb(availableKb)} free on /opt — a Supabase instance needs at least ` +
        `${formatGb(MIN_FREE_KB)}. Free up space (or mount a larger volume at /opt) and retry.`,
    );
  }
  emit("info", `preflight: ${formatGb(availableKb)} free on /opt`);
}

export interface PrepareCtx {
  userId?: string | null;
  userEmail?: string | null;
}

/**
 * Ensure `serverId` is ready to host database instances, using an
 * already-open connection owned by the caller.
 *
 * Returns `false` immediately (emitting nothing) when the row is already
 * `bootstrapped` — the provisioning contract says the `prepare` phase is
 * emitted ONLY when preparation actually happens. Otherwise emits the
 * `› prepare` … `✓ prepare` phase, with preflight + every bootstrap step line
 * nested underneath as `info` detail, flips `bootstrapped`, and audits
 * `server.bootstrap` with `{via:'provision'}`.
 *
 * On failure emits `✗ prepare: {message}` and rethrows — the caller turns that
 * into a failed provisioning job; the server row is left untouched.
 */
export async function ensureServerPrepared(
  serverId: string,
  conn: SshConnection,
  emit: EmitFn,
  opts: PrepareCtx = {},
): Promise<boolean> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) throw new Error(`Server ${serverId} not found`);
  if (server.bootstrapped) return false;

  emit("step", "› prepare");
  try {
    await preflightServer(conn, emit);
    // Nested detail: the UI treats `prepare` as ONE phase, so bootstrap's own
    // `› step` / `✓ step` markers are downgraded to plain info lines.
    await runBootstrapSteps(conn, (_kind, line) => emit("info", line));

    await prisma.server.update({
      where: { id: serverId },
      data: { bootstrapped: true },
    });
    await audit({
      userId: opts.userId ?? null,
      userEmail: opts.userEmail ?? null,
      action: "server.bootstrap",
      targetType: "server",
      targetId: serverId,
      metadata: { via: "provision", steps: BOOTSTRAP_STEPS.length },
    }).catch((auditErr: unknown) => {
      console.error("[prepare] failed to write bootstrap audit row:", auditErr);
    });
    emit("ok", "✓ prepare");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit("err", `✗ prepare: ${message}`);
    throw err;
  }
}
