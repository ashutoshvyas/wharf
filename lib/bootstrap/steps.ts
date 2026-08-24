/**
 * Bootstrap steps — architecture §4.1 "Bootstrap", spec §4
 * "Bootstrap this server". Each step is check-then-apply so the whole run is
 * idempotent and safe to re-run: `check` returning true means "already done —
 * skip"; otherwise `apply` performs the work and throws on failure.
 *
 * All SSH goes through lib/ssh (exec/sftpWrite on the connection the
 * orchestrator opened via withConnection) — never ssh2 directly.
 */
import type { JobEventKind } from "@/lib/jobs/stream";
import { exec, sftpWrite } from "@/lib/ssh";
import { POOLER_NETWORK, POOLER_REMOTE_DIR, TRAEFIK_REMOTE_DIR } from "./constants";
import { renderPoolerTemplates, renderTraefikTemplates } from "./templates";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

export type EmitFn = (kind: JobEventKind, line: string) => void;

export interface BootstrapStep {
  name: string;
  /**
   * true → already satisfied, skip apply. May emit informational lines.
   * `serverId` is only needed by steps that read/write DB-backed per-server
   * state (currently just `installPooler`'s `apply`) — every other step
   * ignores the extra parameter.
   */
  check(conn: SshConnection, emit: EmitFn, serverId: string): Promise<boolean>;
  apply(conn: SshConnection, emit: EmitFn, serverId: string): Promise<void>;
}

/** Max streamed output lines published per step (then one truncation note). */
export const MAX_STEP_LINES = 200;

/**
 * Build an onStdout/onStderr handler that publishes trimmed, non-empty lines
 * as 'info' events, capped at MAX_STEP_LINES per step (one shared budget for
 * stdout + stderr; a single '… output truncated' marker after that).
 */
function lineStreamer(emit: EmitFn): (chunk: string) => void {
  let published = 0;
  let truncated = false;
  return (chunk: string) => {
    for (const raw of chunk.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (published >= MAX_STEP_LINES) {
        if (!truncated) {
          truncated = true;
          emit("info", "… output truncated");
        }
        return;
      }
      published += 1;
      emit("info", line);
    }
  };
}

const COMPOSE = `docker compose -p wharf-traefik -f ${TRAEFIK_REMOTE_DIR}/docker-compose.yml`;

/** Lenient "is the traefik container running" probe — parse failures = no. */
async function traefikRunning(conn: SshConnection): Promise<boolean> {
  try {
    const res = await exec(conn, `${COMPOSE} ps --format json`);
    return (
      res.code === 0 && res.stdout.trim() !== "" && res.stdout.includes('"running"')
    );
  } catch {
    return false;
  }
}

const installDocker: BootstrapStep = {
  name: "installDocker",
  async check(conn) {
    const res = await exec(conn, "docker compose version");
    return res.code === 0;
  },
  async apply(conn, emit) {
    const stream = lineStreamer(emit);
    const res = await exec(conn, "curl -fsSL https://get.docker.com | sh", {
      timeoutMs: 300_000,
      onStdout: stream,
      onStderr: stream,
    });
    if (res.code !== 0) {
      throw new Error(`Docker install script exited with code ${res.code}`);
    }
    const verify = await exec(conn, "docker compose version");
    if (verify.code !== 0) {
      throw new Error(
        "Docker install script finished but `docker compose version` still fails — " +
          "install Docker Engine + the Compose plugin manually and re-run.",
      );
    }
  },
};

const createTraefikNetwork: BootstrapStep = {
  name: "createTraefikNetwork",
  async check(conn) {
    const res = await exec(conn, "docker network inspect traefik");
    return res.code === 0;
  },
  async apply(conn) {
    const res = await exec(conn, "docker network create traefik");
    if (res.code !== 0) {
      throw new Error(
        `docker network create traefik failed (code ${res.code}): ${res.stderr.trim()}`,
      );
    }
  },
};

const createPoolerNetwork: BootstrapStep = {
  name: "createPoolerNetwork",
  async check(conn) {
    const res = await exec(conn, `docker network inspect ${POOLER_NETWORK}`);
    return res.code === 0;
  },
  async apply(conn) {
    const res = await exec(conn, `docker network create ${POOLER_NETWORK}`);
    if (res.code !== 0) {
      throw new Error(
        `docker network create ${POOLER_NETWORK} failed (code ${res.code}): ${res.stderr.trim()}`,
      );
    }
  },
};

const uploadTraefikConfig: BootstrapStep = {
  name: "uploadTraefikConfig",
  // Deliberately never "done": config is re-rendered + re-uploaded every run
  // so re-running bootstrap picks up panel URL / LE email changes.
  async check(_conn, emit) {
    emit("info", "config is refreshed on every run");
    return false;
  },
  async apply(conn) {
    const rendered = await renderTraefikTemplates();
    for (const file of rendered) {
      await sftpWrite(conn, file.remotePath, file.content, 0o644);
    }
    // acme.json must exist before Traefik starts and must be 0600 or Traefik
    // refuses to use it for ACME storage.
    const res = await exec(
      conn,
      `touch ${TRAEFIK_REMOTE_DIR}/acme.json && chmod 600 ${TRAEFIK_REMOTE_DIR}/acme.json`,
    );
    if (res.code !== 0) {
      throw new Error(
        `Failed to prepare acme.json (code ${res.code}): ${res.stderr.trim()}`,
      );
    }
  },
};

const startTraefik: BootstrapStep = {
  name: "startTraefik",
  // Deliberately never "done", matching uploadTraefikConfig's own comment —
  // "is Traefik running" and "is Traefik running the config we just
  // uploaded" are different questions, and this step used to only ask the
  // first one. Once Traefik was up from the very first bootstrap, every
  // later re-run saw it running and skipped `docker compose up -d`
  // entirely, so a changed compose file (e.g. an added environment
  // variable) was uploaded but never actually applied — confirmed live: the
  // container's self-signed cert timestamp still matched its original
  // creation time after a "successful" re-run. `docker compose up -d` is
  // itself idempotent — Compose only recreates a container whose resolved
  // config actually changed, and is an instant no-op otherwise — so always
  // running it here is safe and is what makes re-running bootstrap actually
  // mean something.
  async check(conn, emit) {
    const running = await traefikRunning(conn);
    emit(
      "info",
      running
        ? "Traefik is running — re-applying to pick up any config changes"
        : "Traefik is not running",
    );
    return false;
  },
  async apply(conn, emit) {
    const stream = lineStreamer(emit);
    const res = await exec(conn, `${COMPOSE} up -d`, {
      timeoutMs: 120_000,
      onStdout: stream,
      onStderr: stream,
    });
    if (res.code !== 0) {
      throw new Error(
        `docker compose up -d failed (code ${res.code}): ${res.stderr.trim()}`,
      );
    }
    if (!(await traefikRunning(conn))) {
      throw new Error(
        "Traefik container is not running after `docker compose up -d` — " +
          `check \`${COMPOSE} logs\` on the server.`,
      );
    }
  },
};

const POOLER_COMPOSE = `docker compose -p wharf-pooler -f ${POOLER_REMOTE_DIR}/docker-compose.yml`;

/** Lenient "is the pooler running" probe — parse failures = no (mirrors traefikRunning). */
async function poolerRunning(conn: SshConnection): Promise<boolean> {
  try {
    const res = await exec(conn, `${POOLER_COMPOSE} ps --format json supavisor`);
    return (
      res.code === 0 && res.stdout.trim() !== "" && res.stdout.includes('"running"')
    );
  } catch {
    return false;
  }
}

/**
 * Upload and converge the shared pooler configuration. Exported so the first
 * `require` instance provisioned onto an older, already-bootstrapped server
 * can install the TLS listener before its tenant is registered.
 */
export async function refreshPooler(
  conn: SshConnection,
  emit: EmitFn,
  serverId: string,
): Promise<void> {
  const stream = lineStreamer(emit);
  const rendered = await renderPoolerTemplates(serverId);
  for (const file of rendered) {
    await sftpWrite(conn, file.remotePath, file.content, 0o644);
  }
  const res = await exec(conn, `${POOLER_COMPOSE} up -d`, {
    timeoutMs: 120_000,
    onStdout: stream,
    onStderr: stream,
  });
  if (res.code !== 0) {
    throw new Error(
      `docker compose up -d (pooler) failed (code ${res.code}): ${res.stderr.trim()}`,
    );
  }
  if (!(await poolerRunning(conn))) {
    throw new Error(
      "Pooler containers are not running after `docker compose up -d` — " +
        `check \`${POOLER_COMPOSE} logs\` on the server.`,
    );
  }
}

const installPooler: BootstrapStep = {
  name: "installPooler",
  // Always re-apply. The pooler template now owns persistent TLS material, so
  // a bootstrap re-run must converge older servers onto the certificate mount
  // and downstream TLS environment even when their old containers are healthy.
  async check(conn, emit) {
    const running = await poolerRunning(conn);
    emit(
      "info",
      running
        ? "pooler is running — re-applying to pick up TLS/config changes"
        : "pooler is not running",
    );
    return false;
  },
  async apply(conn, emit, serverId) {
    await refreshPooler(conn, emit, serverId);
  },
};

/** Ports openFirewall opens: Traefik's 80/443, the pooler's 5432/6543. */
const FIREWALL_PORTS = [80, 443, 5432, 6543] as const;

const openFirewall: BootstrapStep = {
  name: "openFirewall",
  async check(conn, emit) {
    const which = await exec(conn, "command -v ufw");
    if (which.code !== 0) {
      emit("info", "ufw not present — ensure ports 80/443/5432/6543 are open");
      return true; // nothing for us to do; report-only (architecture §4.1 step 4)
    }
    const status = await exec(conn, "ufw status");
    return (
      status.code === 0 &&
      FIREWALL_PORTS.every((port) => status.stdout.includes(String(port)))
    );
  },
  async apply(conn) {
    const cmd = FIREWALL_PORTS.map((port) => `ufw allow ${port}/tcp`).join(" && ");
    const res = await exec(conn, cmd);
    if (res.code !== 0) {
      throw new Error(`ufw allow failed (code ${res.code}): ${res.stderr.trim()}`);
    }
  },
};

/** The seven bootstrap steps, in execution order (architecture §4.1 1–4). */
export const BOOTSTRAP_STEPS: readonly BootstrapStep[] = [
  installDocker,
  createTraefikNetwork,
  createPoolerNetwork,
  uploadTraefikConfig,
  startTraefik,
  installPooler,
  openFirewall,
];
