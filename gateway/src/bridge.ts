/**
 * SSH ⇄ WebSocket bridge — one instance of state per connection.
 *
 * Wire protocol: docs/terminal-protocol.md (binary frames = terminal bytes,
 * JSON text frames = control; close codes 1000/4002/4003/4008/4009).
 *
 * Teardown is symmetrical and idempotent: whichever side dies first, the
 * other is closed, timers are cleared, the per-user session slot is released
 * exactly once, and exactly one terminal.close audit row is written (guarded
 * by the `closed` flag).
 *
 * Terminal bytes are piped, never inspected, never logged (spec §4).
 */
import { createHash, randomUUID } from "node:crypto";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { WebSocket, type RawData } from "ws";
import { auditTerminalClose, auditTerminalOpen, type CloseReason } from "./audit.js";
import type { UpgradeContext } from "./auth.js";
import { open } from "./crypto.js";
import { getPrisma } from "./db.js";
import { logger } from "./logger.js";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min without a client frame
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 h hard cap
const MAX_SESSIONS_PER_USER = 3;
const SSH_READY_TIMEOUT_MS = 10_000;
const SSH_KEEPALIVE_MS = 15_000;

/** Live session count per userId (concurrent cap, protocol §Limits). */
const sessionsPerUser = new Map<string, number>();

/** OpenSSH-style fingerprint: "SHA256:" + unpadded base64 of sha256(rawKey). */
function fingerprintOf(key: Buffer): string {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

/** Compare fingerprints tolerant of the "SHA256:" prefix and '=' padding. */
function fingerprintsMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^SHA256:/i, "").replace(/=+$/, "");
  return norm(a) === norm(b);
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function handleConnection(ws: WebSocket, ctx: UpgradeContext): void {
  const sessionId = randomUUID();
  const startedAt = Date.now();
  const identity = {
    sessionId,
    serverId: ctx.serverId,
    userId: ctx.userId,
    userEmail: ctx.email,
  };

  const conn = new Client();
  let stream: ClientChannel | null = null;
  let closed = false;
  let slotReserved = false;
  let hostKeyMismatch = false;
  let exitCode: number | null = null;

  let idleTimer: NodeJS.Timeout | null = null;
  let absoluteTimer: NodeJS.Timeout | null = null;

  const sendJson = (frame: Record<string, unknown>): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const sendError = (message: string): void => {
    // Human-readable error frame, always sent before the close (protocol §Frames).
    sendJson({ t: "error", message });
  };

  /**
   * The single exit path. Idempotent: the first caller wins; every later
   * call (ws close after ssh close, error after close, …) is a no-op.
   * Guarantees, in order: timers cleared, session slot released exactly
   * once, exactly one terminal.close audit row, SSH torn down, WS closed.
   */
  const teardown = (reason: CloseReason, wsCode = 1000, wsReason = ""): void => {
    if (closed) return;
    closed = true;

    if (idleTimer) clearTimeout(idleTimer);
    if (absoluteTimer) clearTimeout(absoluteTimer);
    idleTimer = null;
    absoluteTimer = null;

    if (slotReserved) {
      slotReserved = false;
      const count = sessionsPerUser.get(ctx.userId) ?? 0;
      if (count <= 1) sessionsPerUser.delete(ctx.userId);
      else sessionsPerUser.set(ctx.userId, count - 1);
    }

    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    auditTerminalClose(identity, durationSec, reason);
    logger.info(
      { sessionId, serverId: ctx.serverId, userId: ctx.userId, reason, wsCode, durationSec },
      "terminal session closed",
    );

    try {
      conn.end();
    } catch {
      // already torn down
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(wsCode, wsReason);
    }
  };

  const resetIdle = (): void => {
    if (closed) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      sendError("idle timeout (30 min)");
      teardown("idle", 4008, "idle timeout");
    }, IDLE_TIMEOUT_MS);
  };

  // ---- concurrent-session cap (pre-shell, protocol close 4009) ----
  const current = sessionsPerUser.get(ctx.userId) ?? 0;
  if (current >= MAX_SESSIONS_PER_USER) {
    sendError(`concurrent session limit reached (${MAX_SESSIONS_PER_USER})`);
    teardown("limit", 4009, "session limit");
    return;
  }
  sessionsPerUser.set(ctx.userId, current + 1);
  slotReserved = true;

  // ---- timers ----
  resetIdle();
  absoluteTimer = setTimeout(() => {
    sendError("session exceeded maximum duration (8 h)");
    teardown("absolute", 4008, "absolute timeout");
  }, ABSOLUTE_TIMEOUT_MS);

  // ---- WebSocket side ----
  ws.on("message", (data: RawData, isBinary: boolean) => {
    resetIdle(); // any client frame counts as activity
    if (isBinary) {
      // Raw terminal bytes → SSH stdin. Never inspected, never logged.
      stream?.write(toBuffer(data));
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(toBuffer(data).toString("utf8"));
    } catch {
      return; // malformed control frame — ignore
    }
    if (typeof frame !== "object" || frame === null) return;
    const t = (frame as { t?: unknown }).t;
    if (t === "resize") {
      const { cols, rows } = frame as { cols?: unknown; rows?: unknown };
      if (
        typeof cols === "number" && Number.isInteger(cols) && cols > 0 && cols < 10000 &&
        typeof rows === "number" && Number.isInteger(rows) && rows > 0 && rows < 10000
      ) {
        stream?.setWindow(rows, cols, 0, 0);
      }
    } else if (t === "ping") {
      sendJson({ t: "pong" });
    }
  });
  ws.on("close", () => {
    // Client went away → mirror to SSH.
    teardown("normal");
  });
  ws.on("error", (err) => {
    logger.warn({ sessionId, err: err.message }, "websocket error");
    teardown("normal");
  });

  // ---- SSH side ----
  conn.on("ready", () => {
    if (closed) {
      conn.end();
      return;
    }
    conn.shell(
      { term: "xterm-256color", cols: ctx.cols, rows: ctx.rows },
      (err, shellStream) => {
        if (err) {
          sendError(`failed to open shell: ${err.message}`);
          teardown("ssh_error", 4003, "shell error");
          return;
        }
        if (closed) {
          shellStream.close();
          return;
        }
        stream = shellStream;

        shellStream.on("data", (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
        });
        shellStream.stderr.on("data", (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
        });
        shellStream.on("exit", (code: number | null) => {
          exitCode = typeof code === "number" ? code : null;
        });
        shellStream.on("close", () => {
          // Remote shell ended → tell the client, then normal close.
          sendJson({ t: "exit", code: exitCode });
          teardown("normal", 1000, "shell exited");
        });

        sendJson({ t: "ready" });
        auditTerminalOpen(identity);
        logger.info(
          { sessionId, serverId: ctx.serverId, userId: ctx.userId, role: ctx.role },
          "terminal session opened",
        );
      },
    );
  });
  conn.on("error", (err) => {
    if (closed) return;
    if (hostKeyMismatch) {
      // MITM guard tripped — same failure mode lib/ssh.ts surfaces to the panel.
      sendError("host key changed — refusing to connect (possible MITM)");
      teardown("auth", 4003, "host key changed");
      return;
    }
    const isAuthFailure = err.level === "client-authentication";
    sendError(isAuthFailure ? "SSH authentication failed" : `SSH error: ${err.message}`);
    teardown(isAuthFailure ? "auth" : "ssh_error", 4003, "ssh error");
  });
  conn.on("close", () => {
    // SSH transport gone (covers server-side drops with no error event).
    teardown("normal");
  });

  // ---- load server row, decrypt credential, connect ----
  void (async () => {
    let row;
    try {
      row = await getPrisma().server.findUnique({ where: { id: ctx.serverId } });
    } catch (err) {
      logger.error(
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        "server row lookup failed",
      );
      sendError("internal error loading server");
      teardown("ssh_error", 4003, "lookup failed");
      return;
    }
    if (closed) return;

    if (!row) {
      // Protocol: unknown/deleted server id → 4002.
      sendError("unknown server");
      teardown("ssh_error", 4002, "unknown server");
      return;
    }

    // Decrypt the credential for the row's auth method. Plaintext lives only
    // in this closure for the duration of connect(); it is never logged.
    const config: ConnectConfig = {
      host: row.host,
      port: row.sshPort,
      username: row.sshUser,
      readyTimeout: SSH_READY_TIMEOUT_MS,
      keepaliveInterval: SSH_KEEPALIVE_MS,
      // Host key policy: the panel's lib/ssh.ts is the SINGLE WRITER for TOFU
      // pinning (it stores host_key_fingerprint on first successful panel
      // connection). The gateway only VERIFIES: if a fingerprint is pinned it
      // must match; if none is pinned yet we accept and do NOT persist —
      // two writers could race and pin different (or attacker-supplied) keys,
      // so pinning stays the panel's job.
      hostVerifier: (key: Buffer): boolean => {
        if (!row.hostKeyFingerprint) return true;
        if (fingerprintsMatch(fingerprintOf(key), row.hostKeyFingerprint)) return true;
        hostKeyMismatch = true;
        return false;
      },
    };

    try {
      if (row.authMethod === "password") {
        if (!row.sshPasswordEnc) {
          sendError("server has no stored password credential");
          teardown("auth", 4003, "missing credential");
          return;
        }
        config.password = open(row.sshPasswordEnc);
      } else {
        if (!row.sshPrivateKeyEnc) {
          sendError("server has no stored private key credential");
          teardown("auth", 4003, "missing credential");
          return;
        }
        config.privateKey = open(row.sshPrivateKeyEnc);
      }
    } catch {
      // Decryption failure (wrong master key / corrupt blob) — details stay out
      // of the log and off the wire.
      sendError("credential decryption failed");
      teardown("auth", 4003, "credential error");
      return;
    }

    if (closed) return;
    conn.connect(config);
  })();
}
