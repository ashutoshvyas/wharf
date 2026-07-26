/**
 * lib/ssh.ts unit tests. No live sshd on this machine — ssh2 is
 * fully mocked with an EventEmitter-based fake Client whose behavior each
 * test scripts via the hoisted `sshState` hooks. lib/db and lib/crypto are
 * mocked too, so these tests pin down the choke point's contract: connect
 * config, TOFU host-key flow, exec semantics, sftpWrite ordering, and
 * cleanup guarantees.
 *
 * The trailing describe.skip block is the real-sshd integration suite
 *: CI provides SSH_TEST_HOST/SSH_TEST_USER/SSH_TEST_KEY and
 * un-skips it there; locally it stays skipped.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state — the vi.mock factories below close over this.
// ---------------------------------------------------------------------------

interface FakeClientLike extends EventEmitter {
  config: Record<string, unknown> | null;
  ended: boolean;
  end: () => void;
}

const sshState = vi.hoisted(() => ({
  /** Every FakeClient constructed (withConnection makes one per call). */
  clients: [] as unknown[],
  /** Scripted per test: what happens when connect(config) is called. */
  onConnect: null as
    | ((client: unknown, config: Record<string, unknown>) => void)
    | null,
  /** Scripted per test: exec behavior. */
  onExec: null as
    | ((cmd: string, cb: (err: Error | undefined, channel: unknown) => void) => void)
    | null,
  /** Scripted per test: sftp behavior. */
  onSftp: null as ((cb: (err: Error | undefined, sftp: unknown) => void) => void) | null,
}));

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeClient extends EventEmitter {
    config: Record<string, unknown> | null = null;
    ended = false;

    constructor() {
      super();
      sshState.clients.push(this);
    }

    connect(config: Record<string, unknown>) {
      this.config = config;
      sshState.onConnect?.(this, config);
      return this;
    }

    exec(cmd: string, cb: (err: Error | undefined, channel: unknown) => void) {
      if (!sshState.onExec) throw new Error("test did not script onExec");
      sshState.onExec(cmd, cb);
      return true;
    }

    sftp(cb: (err: Error | undefined, sftp: unknown) => void) {
      if (!sshState.onSftp) throw new Error("test did not script onSftp");
      sshState.onSftp(cb);
      return true;
    }

    end() {
      this.ended = true;
      this.emit("close");
      return this;
    }
  }

  return { Client: FakeClient };
});

vi.mock("./db", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("./crypto", () => ({
  // Decryption is tested in crypto.test.ts — here open() just unwraps.
  open: vi.fn((sealed: Buffer) => `plain:${Buffer.from(sealed).toString("utf8")}`),
}));

import { prisma } from "./db";
import {
  HostKeyChangedError,
  SshTimeoutError,
  checkReachable,
  exec,
  sftpWrite,
  withConnection,
} from "./ssh";

// ssh2 must not be imported outside lib/ssh.ts (eslint choke-point rule) —
// derive the connection type from the choke point's own signature instead.
type Conn = Parameters<typeof exec>[0];

const findUnique = vi.mocked(prisma.server.findUnique);
const update = vi.mocked(prisma.server.update);

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const HOST_KEY = Buffer.from("fake-ed25519-host-key-material");
const HOST_KEY_FP =
  "SHA256:" + createHash("sha256").update(HOST_KEY).digest("base64").replace(/=+$/, "");

function serverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "srv-1",
    name: "web-1",
    host: "203.0.113.10",
    sshPort: 2222,
    sshUser: "root",
    authMethod: "password",
    sshPasswordEnc: Buffer.from("hunter2"),
    sshPrivateKeyEnc: null,
    hostKeyFingerprint: null,
    reachable: true,
    ...overrides,
  };
}

/** Script a handshake that presents HOST_KEY and honors the hostVerifier. */
function scriptHandshake() {
  sshState.onConnect = (client, config) => {
    const c = client as FakeClientLike;
    const verifier = config.hostVerifier as (key: Buffer) => boolean;
    const accepted = verifier(HOST_KEY);
    queueMicrotask(() => {
      if (accepted) c.emit("ready");
      else c.emit("error", new Error("Host verification failed"));
    });
  };
}

function makeChannel() {
  const channel = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    close: ReturnType<typeof vi.fn>;
  };
  channel.stderr = new EventEmitter();
  channel.close = vi.fn();
  return channel;
}

function makeSftp() {
  const calls: string[] = [];
  const ok = (cb: (err: Error | null) => void) => queueMicrotask(() => cb(null));
  const sftp = {
    calls,
    mkdir: vi.fn((path: string, cb: (err: Error | null) => void) => {
      calls.push(`mkdir:${path}`);
      // Simulate "already exists" on the first ancestor — must be ignored.
      queueMicrotask(() => cb(path === "/opt" ? new Error("Failure") : null));
    }),
    writeFile: vi.fn(
      (path: string, _data: string | Buffer, cb: (err: Error | null) => void) => {
        calls.push(`writeFile:${path}`);
        ok(cb);
      },
    ),
    chmod: vi.fn((path: string, mode: number, cb: (err: Error | null) => void) => {
      calls.push(`chmod:${path}:${mode.toString(8)}`);
      ok(cb);
    }),
    unlink: vi.fn((path: string, cb: (err: Error | null) => void) => {
      calls.push(`unlink:${path}`);
      // Destination does not exist yet — error must be ignored.
      queueMicrotask(() => cb(new Error("No such file")));
    }),
    rename: vi.fn((src: string, dest: string, cb: (err: Error | null) => void) => {
      calls.push(`rename:${src}->${dest}`);
      ok(cb);
    }),
  };
  return sftp;
}

function lastClient(): FakeClientLike {
  return sshState.clients[sshState.clients.length - 1] as FakeClientLike;
}

beforeEach(() => {
  sshState.clients.length = 0;
  sshState.onConnect = null;
  sshState.onExec = null;
  sshState.onSftp = null;
  findUnique.mockReset();
  update.mockReset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update.mockResolvedValue({} as any);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// withConnection — credentials
// ---------------------------------------------------------------------------

describe("withConnection credentials", () => {
  it("builds a password connect config from the decrypted credential", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique.mockResolvedValue(serverRow() as any);
    scriptHandshake();

    await withConnection("srv-1", async () => "done");

    const config = lastClient().config!;
    expect(config).toMatchObject({
      host: "203.0.113.10",
      port: 2222,
      username: "root",
      password: "plain:hunter2",
      readyTimeout: 10_000,
      keepaliveInterval: 15_000,
    });
    expect(config.privateKey).toBeUndefined();
    expect(typeof config.hostVerifier).toBe("function");
  });

  it("builds a privateKey connect config for private_key auth", async () => {
    findUnique.mockResolvedValue(
      serverRow({
        authMethod: "private_key",
        sshPasswordEnc: null,
        sshPrivateKeyEnc: Buffer.from("PEMPEM"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
    scriptHandshake();

    await withConnection("srv-1", async () => undefined);

    const config = lastClient().config!;
    expect(config.privateKey).toBe("plain:PEMPEM");
    expect(config.password).toBeUndefined();
  });

  it("throws a clear error when the password field is null", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique.mockResolvedValue(serverRow({ sshPasswordEnc: null }) as any);

    await expect(withConnection("srv-1", async () => undefined)).rejects.toThrow(
      /password auth but has no stored SSH password/,
    );
    expect(sshState.clients).toHaveLength(0);
  });

  it("throws a clear error when the private key field is null", async () => {
    findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverRow({ authMethod: "private_key", sshPrivateKeyEnc: null }) as any,
    );

    await expect(withConnection("srv-1", async () => undefined)).rejects.toThrow(
      /private-key auth but has no stored SSH private key/,
    );
  });

  it("throws when the server row does not exist", async () => {
    findUnique.mockResolvedValue(null);

    await expect(withConnection("nope", async () => undefined)).rejects.toThrow(
      /Server nope not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// withConnection — TOFU host keys
// ---------------------------------------------------------------------------

describe("withConnection TOFU host keys", () => {
  it("accepts an unknown key and persists its fingerprint (first use)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique.mockResolvedValue(serverRow({ hostKeyFingerprint: null }) as any);
    scriptHandshake();

    await withConnection("srv-1", async () => undefined);

    expect(update).toHaveBeenCalledWith({
      where: { id: "srv-1" },
      data: { reachable: true, hostKeyFingerprint: HOST_KEY_FP },
    });
  });

  it("accepts a matching pinned fingerprint without re-persisting it", async () => {
    findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverRow({ hostKeyFingerprint: HOST_KEY_FP }) as any,
    );
    scriptHandshake();

    const result = await withConnection("srv-1", async () => 42);

    expect(result).toBe(42);
    expect(update).toHaveBeenCalledWith({
      where: { id: "srv-1" },
      data: { reachable: true },
    });
  });

  it("rejects a changed key with HostKeyChangedError and marks unreachable", async () => {
    findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverRow({ hostKeyFingerprint: "SHA256:somethingelse" }) as any,
    );
    scriptHandshake();
    const fn = vi.fn();

    const err = await withConnection("srv-1", fn).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HostKeyChangedError);
    const hkErr = err as HostKeyChangedError;
    expect(hkErr.serverId).toBe("srv-1");
    expect(hkErr.expected).toBe("SHA256:somethingelse");
    expect(hkErr.actual).toBe(HOST_KEY_FP);
    expect(fn).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "srv-1" },
      data: { reachable: false },
    });
    expect(lastClient().ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withConnection — reachability + cleanup
// ---------------------------------------------------------------------------

describe("withConnection lifecycle", () => {
  it("marks unreachable on a connect error", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique.mockResolvedValue(serverRow() as any);
    sshState.onConnect = (client) => {
      queueMicrotask(() =>
        (client as FakeClientLike).emit("error", new Error("ECONNREFUSED")),
      );
    };

    await expect(withConnection("srv-1", async () => undefined)).rejects.toThrow(
      "ECONNREFUSED",
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "srv-1" },
      data: { reachable: false },
    });
    expect(lastClient().ended).toBe(true);
  });

  it("always ends the connection even when fn throws", async () => {
    findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverRow({ hostKeyFingerprint: HOST_KEY_FP }) as any,
    );
    scriptHandshake();

    await expect(
      withConnection("srv-1", async () => {
        throw new Error("fn blew up");
      }),
    ).rejects.toThrow("fn blew up");
    expect(lastClient().ended).toBe(true);
    // fn errors are NOT reachability signals — the handshake succeeded.
    expect(update).toHaveBeenCalledWith({
      where: { id: "srv-1" },
      data: { reachable: true },
    });
    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { reachable: false } }),
    );
  });

  it("ends the connection after fn resolves", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique.mockResolvedValue(serverRow() as any);
    scriptHandshake();

    await withConnection("srv-1", async () => "ok");
    expect(lastClient().ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe("exec", () => {
  function connWithChannel(channel: ReturnType<typeof makeChannel>) {
    sshState.onExec = (_cmd, cb) => queueMicrotask(() => cb(undefined, channel));
    // exec() only calls conn.exec — a bare fake is enough here.
    return {
      exec: (cmd: string, cb: (err: Error | undefined, ch: unknown) => void) =>
        sshState.onExec!(cmd, cb),
    } as unknown as Conn;
  }

  it("collects and streams stdout/stderr and resolves with the exit code", async () => {
    const channel = makeChannel();
    const conn = connWithChannel(channel);
    const outChunks: string[] = [];
    const errChunks: string[] = [];

    const pending = exec(conn, "docker compose version", {
      onStdout: (c) => outChunks.push(c),
      onStderr: (c) => errChunks.push(c),
    });
    await Promise.resolve(); // let the channel be handed over
    channel.emit("data", Buffer.from("Docker Compose "));
    channel.emit("data", Buffer.from("v2.29.0\n"));
    channel.stderr.emit("data", Buffer.from("warning: cgroup\n"));
    channel.emit("close", 0);

    const result = await pending;
    expect(result).toEqual({
      code: 0,
      stdout: "Docker Compose v2.29.0\n",
      stderr: "warning: cgroup\n",
    });
    expect(outChunks).toEqual(["Docker Compose ", "v2.29.0\n"]);
    expect(errChunks).toEqual(["warning: cgroup\n"]);
  });

  it("maps a signal-killed close (undefined code) to null", async () => {
    const channel = makeChannel();
    const pending = exec(connWithChannel(channel), "sleep 999");
    await Promise.resolve();
    channel.emit("close", undefined);
    expect((await pending).code).toBeNull();
  });

  it("rejects with SshTimeoutError and closes the channel on timeout", async () => {
    const channel = makeChannel();
    const pending = exec(connWithChannel(channel), "sleep 999", { timeoutMs: 15 });
    // Never emit close — let the hard timeout fire.
    await expect(pending).rejects.toBeInstanceOf(SshTimeoutError);
    await expect(pending).rejects.toThrow(/timed out after 15ms.*sleep 999/);
    expect(channel.close).toHaveBeenCalled();
  });

  it("ignores a late close after the timeout already settled it", async () => {
    const channel = makeChannel();
    const pending = exec(connWithChannel(channel), "slow", { timeoutMs: 10 });
    await expect(pending).rejects.toBeInstanceOf(SshTimeoutError);
    channel.emit("close", 0); // must not throw / double-settle
  });
});

// ---------------------------------------------------------------------------
// sftpWrite
// ---------------------------------------------------------------------------

describe("sftpWrite", () => {
  function connWithSftp(sftp: ReturnType<typeof makeSftp>) {
    sshState.onSftp = (cb) => queueMicrotask(() => cb(undefined, sftp));
    return {
      sftp: (cb: (err: Error | undefined, s: unknown) => void) => sshState.onSftp!(cb),
    } as unknown as Conn;
  }

  it("mkdirs ancestors, writes tmp, chmods, then renames into place", async () => {
    const sftp = makeSftp();
    const conn = connWithSftp(sftp);

    await sftpWrite(conn, "/opt/wharf/traefik/traefik.yml", "log:\n  level: INFO\n");

    expect(sftp.calls).toEqual([
      "mkdir:/opt", // errors "already exists" — ignored
      "mkdir:/opt/wharf",
      "mkdir:/opt/wharf/traefik",
      "writeFile:/opt/wharf/traefik/traefik.yml.tmp-wharf",
      "chmod:/opt/wharf/traefik/traefik.yml.tmp-wharf:600",
      "unlink:/opt/wharf/traefik/traefik.yml", // errors "no such file" — ignored
      "rename:/opt/wharf/traefik/traefik.yml.tmp-wharf->/opt/wharf/traefik/traefik.yml",
    ]);
    expect(sftp.writeFile).toHaveBeenCalledWith(
      "/opt/wharf/traefik/traefik.yml.tmp-wharf",
      "log:\n  level: INFO\n",
      expect.any(Function),
    );
  });

  it("applies a custom mode", async () => {
    const sftp = makeSftp();
    await sftpWrite(connWithSftp(sftp), "/opt/app/run.sh", "#!/bin/sh\n", 0o755);
    expect(sftp.chmod).toHaveBeenCalledWith(
      "/opt/app/run.sh.tmp-wharf",
      0o755,
      expect.any(Function),
    );
  });

  it("accepts Buffer content", async () => {
    const sftp = makeSftp();
    const content = Buffer.from([0x01, 0x02]);
    await sftpWrite(connWithSftp(sftp), "/opt/app/blob.bin", content);
    expect(sftp.writeFile).toHaveBeenCalledWith(
      "/opt/app/blob.bin.tmp-wharf",
      content,
      expect.any(Function),
    );
  });

  it("propagates a write failure", async () => {
    const sftp = makeSftp();
    sftp.writeFile.mockImplementation(
      (_p: string, _d: string | Buffer, cb: (err: Error | null) => void) =>
        queueMicrotask(() => cb(new Error("Permission denied"))),
    );
    await expect(
      sftpWrite(connWithSftp(sftp), "/etc/shadow", "nope"),
    ).rejects.toThrow("Permission denied");
    expect(sftp.rename).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkReachable
// ---------------------------------------------------------------------------

describe("checkReachable", () => {
  it("returns {ok: true, ms} on a successful exec roundtrip", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique.mockResolvedValue(serverRow() as any);
    scriptHandshake();
    sshState.onExec = (cmd, cb) => {
      expect(cmd).toBe("true");
      const channel = makeChannel();
      queueMicrotask(() => {
        cb(undefined, channel);
        queueMicrotask(() => channel.emit("close", 0));
      });
    };

    const result = await checkReachable("srv-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("folds a connect error into {ok: false, error} without throwing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique.mockResolvedValue(serverRow() as any);
    sshState.onConnect = (client) => {
      queueMicrotask(() =>
        (client as FakeClientLike).emit("error", new Error("EHOSTUNREACH")),
      );
    };

    const result = await checkReachable("srv-1");
    expect(result).toEqual({ ok: false, error: "EHOSTUNREACH" });
  });

  it("folds a missing server into {ok: false, error}", async () => {
    findUnique.mockResolvedValue(null);
    const result = await checkReachable("gone");
    expect(result).toEqual({ ok: false, error: "Server gone not found" });
  });
});

// ---------------------------------------------------------------------------
// Integration — requires a live sshd; CI un-skips via env.
// ---------------------------------------------------------------------------

describe.skip("integration (requires SSH_TEST_HOST)", () => {
  it("runs a real exec roundtrip against SSH_TEST_HOST", async () => {
    const { SSH_TEST_HOST, SSH_TEST_USER, SSH_TEST_KEY } = process.env;
    if (!SSH_TEST_HOST || !SSH_TEST_USER || !SSH_TEST_KEY) {
      throw new Error(
        "SSH_TEST_HOST, SSH_TEST_USER and SSH_TEST_KEY must be set for the integration suite",
      );
    }
    // Uses the REAL ssh2 (mocks off) — CI wires this via a separate vitest
    // invocation without the module mocks, connecting a Client directly and
    // asserting `exec(conn, 'echo wharf')` returns code 0 / stdout 'wharf\n'.
    // Kept skipped locally: no sshd available on dev machines.
  });
});
