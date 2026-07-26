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
import { TRAEFIK_REMOTE_DIR } from "./constants";
import { renderTraefikTemplates } from "./templates";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

export type EmitFn = (kind: JobEventKind, line: string) => void;

export interface BootstrapStep {
  name: string;
  /** true → already satisfied, skip apply. May emit informational lines. */
  check(conn: SshConnection, emit: EmitFn): Promise<boolean>;
  apply(conn: SshConnection, emit: EmitFn): Promise<void>;
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
  check(conn) {
    return traefikRunning(conn);
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

const openFirewall: BootstrapStep = {
  name: "openFirewall",
  async check(conn, emit) {
    const which = await exec(conn, "command -v ufw");
    if (which.code !== 0) {
      emit("info", "ufw not present — ensure ports 80/443 are open");
      return true; // nothing for us to do; report-only (architecture §4.1 step 4)
    }
    const status = await exec(conn, "ufw status");
    return (
      status.code === 0 &&
      status.stdout.includes("80") &&
      status.stdout.includes("443")
    );
  },
  async apply(conn) {
    const res = await exec(conn, "ufw allow 80/tcp && ufw allow 443/tcp");
    if (res.code !== 0) {
      throw new Error(
        `ufw allow 80/443 failed (code ${res.code}): ${res.stderr.trim()}`,
      );
    }
  },
};

/** The five bootstrap steps, in execution order (architecture §4.1 1–4). */
export const BOOTSTRAP_STEPS: readonly BootstrapStep[] = [
  installDocker,
  createTraefikNetwork,
  uploadTraefikConfig,
  startTraefik,
  openFirewall,
];
