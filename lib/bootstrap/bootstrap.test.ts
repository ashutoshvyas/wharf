import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Fake SSH surface — every step goes through exec/sftpWrite (lib/ssh). */
const execMock = vi.fn();
const sftpWriteMock = vi.fn();
const withConnectionMock = vi.fn();

vi.mock("@/lib/ssh", () => ({
  exec: (...args: unknown[]) => execMock(...args),
  sftpWrite: (...args: unknown[]) => sftpWriteMock(...args),
  withConnection: (...args: unknown[]) => withConnectionMock(...args),
}));

const serverUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { server: { update: (...a: unknown[]) => serverUpdate(...a) } },
}));

const auditMock = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

import { MAX_STEP_LINES, BOOTSTRAP_STEPS } from "./steps";
import { renderTraefikTemplates, substitutePlaceholders, TRAEFIK_TEMPLATE_FILES } from "./templates";
import { TRAEFIK_REMOTE_DIR, WHARF_AUTH_MIDDLEWARE, TRAEFIK_NETWORK } from "./constants";
import { bootstrapJobId, runBootstrap } from "./run";
import { serverLockHolder, tryAcquireServerLock } from "@/lib/jobs/lock";
import { subscribe } from "@/lib/jobs/stream";

const CTX = { userId: "u1", userEmail: "admin@wharf.example.com" };
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ code: 1, stdout: "", stderr });

/** Collect a job's lines and resolve when it ends. */
function watchJob(jobId: string) {
  const lines: string[] = [];
  const done = new Promise<{ status: string; lines: string[] }>((resolve) => {
    // subscribe() replays buffered events, so a late subscribe still sees all.
    setTimeout(() => {
      subscribe(
        jobId,
        (ev) => lines.push(`${ev.kind}|${ev.line}`),
        (end) => resolve({ status: end.status, lines }),
      );
    }, 0);
  });
  return done;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PANEL_URL = "https://panel.wharf.example.com";
  process.env.LETSENCRYPT_EMAIL = "ops@wharf.example.com";
  // Default: withConnection just invokes the callback with a token handle.
  withConnectionMock.mockImplementation(
    async (_id: string, fn: (c: unknown) => Promise<unknown>) => fn({ conn: true }),
  );
  serverUpdate.mockResolvedValue({});
});

describe("templates", () => {
  it("substitutes both placeholders everywhere and leaves no {{ }} behind", async () => {
    const rendered = await renderTraefikTemplates();
    expect(rendered).toHaveLength(TRAEFIK_TEMPLATE_FILES.length);
    for (const file of rendered) {
      expect(file.content).not.toContain("{{");
      expect(file.remotePath).toBe(`${TRAEFIK_REMOTE_DIR}/${file.relPath}`);
    }
    const authFile = rendered.find((f) => f.relPath === "dynamic/wharf-auth.yml");
    expect(authFile?.content).toContain("https://panel.wharf.example.com/api/auth/verify");
    const traefikYml = rendered.find((f) => f.relPath === "traefik.yml");
    expect(traefikYml?.content).toContain("ops@wharf.example.com");
  });

  it("trims a trailing slash on PANEL_URL so forwardAuth never gets //api", async () => {
    process.env.PANEL_URL = "https://panel.wharf.example.com/";
    const rendered = await renderTraefikTemplates();
    const authFile = rendered.find((f) => f.relPath === "dynamic/wharf-auth.yml");
    expect(authFile?.content).toContain("https://panel.wharf.example.com/api/auth/verify");
    expect(authFile?.content).not.toContain("//api/auth/verify");
  });

  it("throws a clear error when PANEL_URL or LETSENCRYPT_EMAIL is missing", async () => {
    delete process.env.LETSENCRYPT_EMAIL;
    await expect(renderTraefikTemplates()).rejects.toThrow(/PANEL_URL and LETSENCRYPT_EMAIL/);
  });

  it("substitutePlaceholders replaces every occurrence", () => {
    const out = substitutePlaceholders("a{{PANEL_URL}}b{{PANEL_URL}}c{{LE_EMAIL}}", {
      panelUrl: "P",
      leEmail: "E",
    });
    expect(out).toBe("aPbPcE");
  });

  it("checked-in templates carry the exact names provisioning will reference", async () => {
    const base = path.join(process.cwd(), "templates", "traefik");
    const auth = await readFile(path.join(base, "dynamic/wharf-auth.yml"), "utf8");
    // The middleware key must match WHARF_AUTH_MIDDLEWARE ("wharf-auth@file").
    expect(auth).toContain(WHARF_AUTH_MIDDLEWARE.split("@")[0]!);
    const compose = await readFile(path.join(base, "docker-compose.yml"), "utf8");
    expect(compose).toContain(TRAEFIK_NETWORK);
    expect(compose).toContain("external: true");
    // Bugfix regression: Traefik v3.1-v3.5's docker provider hardcoded API
    // version 1.24 as its negotiation baseline and did not reliably respect
    // an explicit DOCKER_API_VERSION override either (confirmed against a
    // real host — setting it had zero effect, identical daemon error, even
    // after a full container recreation). Modern Docker Engine releases
    // (29.x+) refuse that version outright, so Traefik silently never
    // discovers ANY container's labels — retrying forever with no visible
    // error anywhere except its own logs. v3.6.1 fixed this with proper
    // automatic negotiation; pin at least that high, never on v3.0-v3.5.
    const [, major, minor] = /image:\s*traefik:v(\d+)\.(\d+)/.exec(compose) ?? [];
    expect(major).toBeTruthy();
    const majorNum = Number(major);
    const minorNum = Number(minor);
    expect(majorNum > 3 || (majorNum === 3 && minorNum >= 6)).toBe(true);
    const yml = await readFile(path.join(base, "traefik.yml"), "utf8");
    expect(yml).toContain("letsencrypt");
    expect(yml).toContain("httpChallenge");
    expect(yml).toContain("exposedByDefault: false");
  });
});

describe("bootstrap orchestrator", () => {
  it("skips install/network/firewall on a re-run and still marks the server bootstrapped", async () => {
    // docker present, network exists, traefik running, ufw has 80+443.
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd.includes("ps --format json")) return Promise.resolve(ok('[{"State":"running"}]'));
      if (cmd === "ufw status") return Promise.resolve(ok("80/tcp ALLOW\n443/tcp ALLOW"));
      return Promise.resolve(ok());
    });

    const res = runBootstrap("srv-skip", CTX);
    expect(res).toHaveProperty("jobId");
    const { status, lines } = await watchJob(bootstrapJobId("srv-skip"));

    expect(status).toBe("ok");
    // uploadTraefikConfig and startTraefik always apply (bugfix: a re-run
    // must actually pick up a changed compose file, e.g. an added env var —
    // not just confirm the old container is still running); only
    // installDocker, createTraefikNetwork and openFirewall report skipped.
    const skipped = lines.filter((l) => l.includes("already done — skipped"));
    expect(skipped).toHaveLength(3);
    expect(sftpWriteMock).toHaveBeenCalledTimes(TRAEFIK_TEMPLATE_FILES.length);
    // The actual regression: `docker compose ... up -d` must run even when
    // Traefik was already up, or an uploaded config change is silently inert.
    expect(
      execMock.mock.calls.some((c) => String(c[1]).includes("up -d")),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes("re-applying to pick up any config changes")),
    ).toBe(true);
    expect(serverUpdate).toHaveBeenCalledWith({
      where: { id: "srv-skip" },
      data: { bootstrapped: true },
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "server.bootstrap", targetId: "srv-skip" }),
    );
    expect(serverLockHolder("srv-skip")).toBeNull(); // lock released
  });

  it("applies steps in order on a fresh host, with acme.json chmod 600", async () => {
    const calls: string[] = [];
    let dockerInstalled = false;
    let traefikUp = false;
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      calls.push(cmd);
      if (cmd === "docker compose version") {
        return Promise.resolve(dockerInstalled ? ok() : fail("not found"));
      }
      if (cmd.includes("get.docker.com")) {
        dockerInstalled = true;
        return Promise.resolve(ok());
      }
      if (cmd === "docker network inspect traefik") return Promise.resolve(fail());
      if (cmd.includes("ps --format json")) {
        return Promise.resolve(traefikUp ? ok('[{"State":"running"}]') : ok(""));
      }
      if (cmd.includes("up -d")) {
        traefikUp = true;
        return Promise.resolve(ok());
      }
      if (cmd === "command -v ufw") return Promise.resolve(ok("/usr/sbin/ufw"));
      if (cmd === "ufw status") return Promise.resolve(ok("Status: inactive"));
      return Promise.resolve(ok());
    });

    runBootstrap("srv-fresh", CTX);
    const { status } = await watchJob(bootstrapJobId("srv-fresh"));
    expect(status).toBe("ok");

    const idx = (needle: string) => calls.findIndex((c) => c.includes(needle));
    expect(idx("get.docker.com")).toBeGreaterThanOrEqual(0);
    expect(idx("get.docker.com")).toBeLessThan(idx("docker network create"));
    expect(idx("docker network create")).toBeLessThan(idx("up -d"));
    expect(idx("up -d")).toBeLessThan(idx("ufw allow"));
    // acme.json prepared with 0600 before Traefik starts
    const acme = calls.find((c) => c.includes("acme.json"))!;
    expect(acme).toContain(`touch ${TRAEFIK_REMOTE_DIR}/acme.json`);
    expect(acme).toContain(`chmod 600 ${TRAEFIK_REMOTE_DIR}/acme.json`);
    expect(calls.indexOf(acme)).toBeLessThan(idx("up -d"));
    // config uploaded to the right places with 0644
    for (const rel of TRAEFIK_TEMPLATE_FILES) {
      expect(sftpWriteMock).toHaveBeenCalledWith(
        expect.anything(),
        `${TRAEFIK_REMOTE_DIR}/${rel}`,
        expect.any(String),
        0o644,
      );
    }
  });

  it("reports 'ufw not present' as nothing-to-do rather than failing", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd === "command -v ufw") return Promise.resolve(fail());
      if (cmd.includes("ps --format json")) return Promise.resolve(ok('[{"State":"running"}]'));
      return Promise.resolve(ok());
    });
    runBootstrap("srv-noufw", CTX);
    const { status, lines } = await watchJob(bootstrapJobId("srv-noufw"));
    expect(status).toBe("ok");
    expect(lines.some((l) => l.includes("ufw not present"))).toBe(true);
    expect(execMock).not.toHaveBeenCalledWith(expect.anything(), "ufw allow 80/tcp && ufw allow 443/tcp");
  });

  it("ends the job in error, releases the lock and leaves the row untouched on failure", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string) => {
      if (cmd === "docker compose version") return Promise.resolve(fail());
      if (cmd.includes("get.docker.com")) return Promise.resolve(fail("network unreachable"));
      return Promise.resolve(ok());
    });

    runBootstrap("srv-boom", CTX);
    const { status, lines } = await watchJob(bootstrapJobId("srv-boom"));

    expect(status).toBe("error");
    expect(lines.some((l) => l.startsWith("err|"))).toBe(true);
    expect(serverUpdate).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "server.bootstrap.failed" }),
    );
    expect(serverLockHolder("srv-boom")).toBeNull();
  });

  it("surfaces an SSH connection failure as a job error", async () => {
    withConnectionMock.mockRejectedValue(new Error("All configured authentication methods failed"));
    runBootstrap("srv-unreachable", CTX);
    const { status, lines } = await watchJob(bootstrapJobId("srv-unreachable"));
    expect(status).toBe("error");
    expect(lines.some((l) => l.includes("authentication methods failed"))).toBe(true);
    expect(serverUpdate).not.toHaveBeenCalled();
  });

  it("returns the lock holder instead of starting a second job", () => {
    const release = tryAcquireServerLock("srv-busy", "provision")!;
    const res = runBootstrap("srv-busy", CTX);
    expect(res).toEqual({ busy: "provision" });
    release();
  });

  it("caps streamed output at MAX_STEP_LINES with one truncation marker", async () => {
    execMock.mockImplementation((_c: unknown, cmd: string, opts?: { onStdout?: (s: string) => void }) => {
      if (cmd === "docker compose version") {
        // fail the first check so apply (and its streaming) runs
        return Promise.resolve(execMock.mock.calls.length > 2 ? ok() : fail());
      }
      if (cmd.includes("get.docker.com")) {
        const many = Array.from({ length: MAX_STEP_LINES + 75 }, (_, i) => `line ${i}`).join("\n");
        opts?.onStdout?.(many);
        return Promise.resolve(ok());
      }
      if (cmd.includes("ps --format json")) return Promise.resolve(ok('[{"State":"running"}]'));
      if (cmd === "command -v ufw") return Promise.resolve(fail());
      return Promise.resolve(ok());
    });

    runBootstrap("srv-chatty", CTX);
    const { lines } = await watchJob(bootstrapJobId("srv-chatty"));
    const info = lines.filter((l) => l.startsWith("info|line "));
    expect(info).toHaveLength(MAX_STEP_LINES);
    expect(lines.filter((l) => l.includes("output truncated"))).toHaveLength(1);
  });

  it("exposes exactly the five documented steps in order", () => {
    expect(BOOTSTRAP_STEPS.map((s) => s.name)).toEqual([
      "installDocker",
      "createTraefikNetwork",
      "uploadTraefikConfig",
      "startTraefik",
      "openFirewall",
    ]);
  });
});
