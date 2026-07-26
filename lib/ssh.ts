/**
 * WHARF SSH connection service — architecture §4.1.
 *
 * THE single choke point for all SSH in the panel process. Nothing else in
 * the codebase may import `ssh2` (enforced by eslint `no-restricted-imports`;
 * the only other legitimate consumer is the terminal gateway under
 * `gateway/**`, a separate service). Every SSH interaction — reachability
 * checks, bootstrap, provisioning, teardown — flows through
 * `withConnection()` so that credential decryption, host-key verification,
 * reachability bookkeeping, and connection cleanup happen in exactly one
 * place.
 *
 * CREDENTIALS — decrypted in-memory only, via lib/crypto `open()` (AES-256-GCM
 * under WHARF_MASTER_KEY, §6). Plaintext lives for the duration of the
 * connect call and is never logged or persisted.
 *
 * HOST-KEY POLICY — TOFU (trust on first use), §6/§7:
 *   - `servers.host_key_fingerprint` null → the first successful connection
 *     accepts the presented key and persists its fingerprint
 *     (`SHA256:` + base64(sha256(key)), no trailing '=' — OpenSSH format)
 *     on the row, pinning it.
 *   - Fingerprint set and matching → accept.
 *   - Fingerprint set and different → hard fail with HostKeyChangedError
 *     (MITM guard) and mark the server unreachable. Recovery is a deliberate
 *     admin action (clearing the stored fingerprint), never automatic.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import { open } from "./crypto";
import { prisma } from "./db";

/** Thrown when a server presents a host key that differs from the pinned one. */
export class HostKeyChangedError extends Error {
  readonly serverId: string;
  readonly expected: string;
  readonly actual: string;

  constructor(serverId: string, expected: string, actual: string) {
    super(
      `Host key changed for server ${serverId}: expected ${expected}, got ${actual}. ` +
        "This may indicate a MITM attack or a rebuilt host. Refusing to connect.",
    );
    this.name = "HostKeyChangedError";
    this.serverId = serverId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Thrown when an exec exceeds its hard timeout. The channel is closed first. */
export class SshTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshTimeoutError";
  }
}

/** OpenSSH-style fingerprint: 'SHA256:' + base64(sha256(key)), no padding. */
function fingerprintOf(key: Buffer): string {
  return (
    "SHA256:" +
    createHash("sha256").update(key).digest("base64").replace(/=+$/, "")
  );
}

/** Fire-and-forget row update — never let bookkeeping failures mask SSH errors. */
function updateServer(
  serverId: string,
  data: { reachable: boolean; hostKeyFingerprint?: string },
): void {
  void prisma.server
    .update({ where: { id: serverId }, data })
    .catch((err: unknown) => {
      console.error(`[ssh] failed to update server ${serverId} row:`, err);
    });
}

/**
 * Open an SSH connection to `serverId`, run `fn(conn)`, and ALWAYS close the
 * connection. Decrypts the stored credential in-memory (password or private
 * key per `authMethod`), verifies the host key per the TOFU policy above,
 * and keeps `servers.reachable` current (fire-and-forget: true after a
 * successful handshake, false on any connect failure).
 */
export async function withConnection<T>(
  serverId: string,
  fn: (conn: Client) => Promise<T>,
): Promise<T> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) throw new Error(`Server ${serverId} not found`);

  let password: string | undefined;
  let privateKey: string | undefined;
  if (server.authMethod === "password") {
    if (!server.sshPasswordEnc) {
      throw new Error(
        `Server ${serverId} uses password auth but has no stored SSH password.`,
      );
    }
    password = open(server.sshPasswordEnc);
  } else {
    if (!server.sshPrivateKeyEnc) {
      throw new Error(
        `Server ${serverId} uses private-key auth but has no stored SSH private key.`,
      );
    }
    privateKey = open(server.sshPrivateKeyEnc);
  }

  const conn = new Client();
  // Set inside hostVerifier (synchronous, during handshake), read afterwards.
  let pendingFingerprint: string | null = null;
  let mismatch: { expected: string; actual: string } | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        // hostVerifier returning false makes ssh2 abort the handshake and
        // emit a generic error — translate it into the explicit MITM guard.
        if (mismatch) {
          err = new HostKeyChangedError(serverId, mismatch.expected, mismatch.actual);
        }
        updateServer(serverId, { reachable: false });
        reject(err);
      };
      conn.on("ready", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      conn.on("error", fail);
      conn.on("close", () => fail(new Error("SSH connection closed before ready")));
      conn.connect({
        host: server.host,
        port: server.sshPort,
        username: server.sshUser,
        password,
        privateKey,
        readyTimeout: 10_000,
        keepaliveInterval: 15_000,
        hostVerifier: (key: Buffer): boolean => {
          const actual = fingerprintOf(key);
          if (!server.hostKeyFingerprint) {
            // TOFU: accept now, persist once after the handshake completes
            // (only a fully successful connection pins the key).
            pendingFingerprint = actual;
            return true;
          }
          if (server.hostKeyFingerprint === actual) return true;
          mismatch = { expected: server.hostKeyFingerprint, actual };
          return false;
        },
      });
    });

    // Connected: pin the TOFU fingerprint (single write) + mark reachable.
    updateServer(
      serverId,
      pendingFingerprint
        ? { reachable: true, hostKeyFingerprint: pendingFingerprint }
        : { reachable: true },
    );

    return await fn(conn);
  } finally {
    conn.end();
  }
}

export interface ExecOptions {
  /** Hard timeout in ms (default 60 000). On expiry the channel is closed. */
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `cmd` on an open connection, collecting (and optionally streaming)
 * stdout/stderr. Rejects with SshTimeoutError after `timeoutMs` (the channel
 * is closed so the remote side is not left running against a dead listener).
 */
export function exec(
  conn: Client,
  cmd: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise<ExecResult>((resolve, reject) => {
    conn.exec(cmd, (err: Error | undefined, channel: ClientChannel) => {
      if (err) return reject(err);

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        channel.close();
        reject(
          new SshTimeoutError(`Command timed out after ${timeoutMs}ms: ${cmd}`),
        );
      }, timeoutMs);

      channel.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        opts.onStdout?.(text);
      });
      channel.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        opts.onStderr?.(text);
      });
      channel.on("close", (code: number | null | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? null, stdout, stderr });
      });
      channel.on("error", (channelErr: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(channelErr);
      });
    });
  });
}

function getSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

function sftpCall(
  run: (cb: (err: Error | null | undefined) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    run((err) => (err ? reject(err) : resolve()));
  });
}

/** Every ancestor directory of `remotePath`, shallowest first (mkdir -p order). */
function ancestorDirs(remotePath: string): string[] {
  const dir = posix.dirname(remotePath);
  if (dir === "/" || dir === "." || dir === "") return [];
  const parts = dir.split("/").filter(Boolean);
  const prefix = dir.startsWith("/") ? "/" : "";
  return parts.map((_, i) => prefix + parts.slice(0, i + 1).join("/"));
}

/**
 * Write `content` to `remotePath` over SFTP:
 *   1. mkdir -p the parent directories (existing-dir failures ignored),
 *   2. write to `${remotePath}.tmp-wharf`,
 *   3. chmod the temp file to `mode` (so it never appears at the final path
 *      with looser permissions),
 *   4. rename over the destination (atomic-ish; a pre-existing destination
 *      is unlinked first since SFTP rename does not overwrite portably).
 */
export async function sftpWrite(
  conn: Client,
  remotePath: string,
  content: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const sftp = await getSftp(conn);
  for (const dir of ancestorDirs(remotePath)) {
    // mkdir -p style: an already-existing directory surfaces as a generic
    // SFTP failure — ignore it; if a dir is genuinely missing the write
    // below fails loudly.
    await sftpCall((cb) => sftp.mkdir(dir, cb)).catch(() => {});
  }
  const tmpPath = `${remotePath}.tmp-wharf`;
  await sftpCall((cb) => sftp.writeFile(tmpPath, content, cb));
  await sftpCall((cb) => sftp.chmod(tmpPath, mode, cb));
  await sftpCall((cb) => sftp.unlink(remotePath, cb)).catch(() => {});
  await sftpCall((cb) => sftp.rename(tmpPath, remotePath, cb));
}

/**
 * Cheap reachability probe: connect + `exec('true')` with a 5s timeout.
 * Never throws — all failures fold into `{ok: false, error}`. Reachability
 * persistence on the row is handled inside withConnection.
 */
export async function checkReachable(
  serverId: string,
): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  const start = Date.now();
  try {
    await withConnection(serverId, async (conn) => {
      await exec(conn, "true", { timeoutMs: 5_000 });
    });
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
