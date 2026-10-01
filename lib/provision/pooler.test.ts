import { beforeEach, describe, expect, it, vi } from "vitest";
import { jwtVerify } from "jose";

const execMock = vi.fn();
vi.mock("@/lib/ssh", () => ({
  exec: (...a: unknown[]) => execMock(...a),
}));

const ensurePoolerSecretsMock = vi.fn();
vi.mock("@/lib/bootstrap/pooler-secrets", () => ({
  ensurePoolerSecrets: (...a: unknown[]) => ensurePoolerSecretsMock(...a),
}));

import { assertPoolerNetworkPolicy, deregisterPoolerTenant, readPoolerNetworkState, registerPoolerTenant } from "./pooler";

const CONN = { conn: true } as never;
/** curl's own `-w '\n%{http_code}'` suffix — every 2xx fixture must include it. */
const ok = (body = "", httpCode = 200) => ({ code: 0, stdout: `${body}\n${httpCode}`, stderr: "" });
/** curl itself never completed the request (DNS, connection refused, timeout). */
const transportFail = (stderr = "boom") => ({ code: 22, stdout: "", stderr });
/** curl completed the request, but Supavisor's own HTTP response was an error. */
const httpFail = (errorBody: string, httpCode = 400) => ({
  code: 0,
  stdout: `${JSON.stringify({ error: errorBody })}\n${httpCode}`,
  stderr: "",
});
const API_JWT_SECRET = "s".repeat(40);

beforeEach(() => {
  vi.clearAllMocks();
  ensurePoolerSecretsMock.mockResolvedValue({ apiJwtSecret: API_JWT_SECRET });
  execMock.mockResolvedValue(ok());
});

describe("registerPoolerTenant", () => {
  it("sends only this tenant's allowlist and preserves its TLS policy", async () => {
    await registerPoolerTenant(CONN, { serverId: "srv-1", project: "sb_4f2a", pgPassword: "test", sslMode: "require",
      networkAccess: { mode: "restricted", allowedCidrs: ["198.51.100.10", "198.51.100.0/24"] } });
    const cmd = execMock.mock.calls[0]![1] as string;
    const body = JSON.parse(/-d '(\{.*\})'/.exec(cmd)![1]!);
    expect(body.tenant.allow_list).toEqual(["198.51.100.10/32", "198.51.100.0/24"]);
    expect(body.tenant.enforce_ssl).toBe(true);
  });

  it("blocks new clients and disconnects existing clients without creating an open tenant", async () => {
    await registerPoolerTenant(CONN, { serverId: "srv-1", project: "sb_4f2a", pgPassword: "", sslMode: "require",
      networkAccess: { mode: "blocked" } });
    const commands = execMock.mock.calls.map((call) => String(call[1]));
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("-X DELETE");
    expect(commands[1]).toContain("-X GET");
    expect(commands[1]).toContain("/sb_4f2a/terminate");
    expect(commands.join(" ")).not.toContain("-X PUT");
  });

  it("sets both address families explicitly for Allow all", async () => {
    await registerPoolerTenant(CONN, { serverId: "srv-1", project: "sb_4f2a", pgPassword: "test", sslMode: "require",
      networkAccess: { mode: "all" } });
    expect(execMock.mock.calls[0]![1]).toContain('"allow_list":["0.0.0.0/0","::/0"]');
  });

  it("does not accept an unconfirmed disconnect as successfully blocking access", async () => {
    execMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(httpFail("unavailable", 500));
    await expect(registerPoolerTenant(CONN, { serverId: "srv-1", project: "sb_4f2a", pgPassword: "", sslMode: "require",
      networkAccess: { mode: "blocked" } })).rejects.toThrow("connection termination");
  });
  it("PUTs the tenant with db_host set to the project's pooler alias, bearer-authenticated", async () => {
    await registerPoolerTenant(CONN, {
      serverId: "srv-1",
      project: "sb_4f2a",
      pgPassword: "PgPass123",
      sslMode: "require",
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    const [conn, cmd] = execMock.mock.calls[0] as [unknown, string];
    expect(conn).toBe(CONN);
    expect(cmd).toContain("curl -sS --connect-timeout 5 --max-time 30 -w '\\n%{http_code}' -X PUT");
    expect(cmd).toContain("http://127.0.0.1:4000/api/tenants/sb_4f2a");

    const bearer = /Authorization: Bearer ([\w.-]+)/.exec(cmd)?.[1];
    expect(bearer).toBeTruthy();
    const { payload } = await jwtVerify(bearer!, new TextEncoder().encode(API_JWT_SECRET));
    expect(payload.role).toBe("service_role");

    const body = /-d '(\{.*\})'/.exec(cmd)?.[1];
    expect(JSON.parse(body!)).toEqual({
      tenant: {
        // Hyphenated, not "sb_4f2a-db" — see naming.ts's poolerDbAlias.
        db_host: "sb-4f2a-db",
        db_port: 5432,
        db_database: "postgres",
        // All required (or defensive) for tenant creation to succeed against
        // a real Supavisor — see the module's inline comments for why.
        default_parameter_status: {},
        require_user: true,
        ip_version: "v4",
        default_pool_size: 15,
        default_max_clients: 200,
        enforce_ssl: true,
        users: [
          {
            db_user: "postgres",
            db_password: "PgPass123",
            pool_size: 15,
            mode_type: "transaction",
            is_manager: true,
          },
        ],
      },
    });
  });

  it("throws with the curl failure surfaced when curl itself never completes the request", async () => {
    execMock.mockResolvedValue(transportFail("connection refused"));
    await expect(
      registerPoolerTenant(CONN, {
        serverId: "srv-1",
        project: "sb_4f2a",
        pgPassword: "x",
        sslMode: "require",
      }),
    ).rejects.toThrow(/Supavisor tenant registration failed \(curl exit 22\).*connection refused/s);
  });

  it("throws with Supavisor's own error body when it responds with a non-2xx", async () => {
    execMock.mockResolvedValue(
      httpFail("default_parameter_status can't be blank, require_user can't be blank"),
    );
    await expect(
      registerPoolerTenant(CONN, {
        serverId: "srv-1",
        project: "sb_4f2a",
        pgPassword: "x",
        sslMode: "require",
      }),
    ).rejects.toThrow(
      /Supavisor tenant registration failed \(HTTP 400\).*default_parameter_status can't be blank/s,
    );
  });

  it("allows plaintext for a disabled tenant", async () => {
    await registerPoolerTenant(CONN, {
      serverId: "srv-1",
      project: "sb_4f2a",
      pgPassword: "PgPass123",
      sslMode: "disable",
    });

    const [, cmd] = execMock.mock.calls[0] as [unknown, string];
    const body = /-d '(\{.*\})'/.exec(cmd)?.[1];
    expect(JSON.parse(body!).tenant.enforce_ssl).toBe(false);
  });
});

describe("pooler network verification", () => {
  it("reads only tenant ids and IP policies, without retrieving user credentials", async () => {
    const rows = [{ external_id: "sb_4f2a", allow_list: ["198.51.100.10/32"] }];
    execMock.mockResolvedValue({ code: 0, stdout: JSON.stringify(rows), stderr: "" });
    await expect(readPoolerNetworkState(CONN)).resolves.toEqual(rows);
    const command = execMock.mock.calls[0]![1] as string;
    expect(command).not.toContain("password");
    expect(command).not.toContain("SELECT *");
    expect(() => assertPoolerNetworkPolicy(rows, "sb_4f2a", { mode: "restricted", allowedCidrs: ["198.51.100.10/32"] })).not.toThrow();
    expect(() => assertPoolerNetworkPolicy(rows, "sb_4f2a", { mode: "all" })).toThrow();
    expect(() => assertPoolerNetworkPolicy(rows, "sb_4f2a", { mode: "blocked" })).toThrow();
    expect(() => assertPoolerNetworkPolicy([], "sb_4f2a", { mode: "blocked" })).not.toThrow();
  });
});

describe("deregisterPoolerTenant", () => {
  it("DELETEs the tenant, bearer-authenticated", async () => {
    execMock.mockResolvedValue(ok("", 204));
    await deregisterPoolerTenant(CONN, "srv-1", "sb_4f2a");
    const [, cmd] = execMock.mock.calls[0] as [unknown, string];
    expect(cmd).toContain("curl -sS --connect-timeout 5 --max-time 30 -w '\\n%{http_code}' -X DELETE");
    expect(cmd).toContain("http://127.0.0.1:4000/api/tenants/sb_4f2a");
  });

  it("throws with the curl failure surfaced when curl itself never completes the request", async () => {
    execMock.mockResolvedValue(transportFail("connection refused"));
    await expect(deregisterPoolerTenant(CONN, "srv-1", "sb_4f2a")).rejects.toThrow(
      /Supavisor tenant deregistration failed \(curl exit 22\).*connection refused/s,
    );
  });

  it("throws with Supavisor's own error body on a non-404 HTTP error", async () => {
    execMock.mockResolvedValue(httpFail("internal error", 500));
    await expect(deregisterPoolerTenant(CONN, "srv-1", "sb_4f2a")).rejects.toThrow(
      /Supavisor tenant deregistration failed \(HTTP 500\).*internal error/s,
    );
  });

  it("treats a 404 (already gone) as success, not a failure", async () => {
    execMock.mockResolvedValue(httpFail("not found", 404));
    await expect(deregisterPoolerTenant(CONN, "srv-1", "sb_4f2a")).resolves.toBeUndefined();
  });
});
