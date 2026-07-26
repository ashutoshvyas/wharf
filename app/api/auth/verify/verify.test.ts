import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { encode } from "@auth/core/jwt";
import { GET } from "./route";

const SECRET = randomBytes(32).toString("base64");
const COOKIE = "wharf.session";

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
  process.env.PANEL_URL = "https://panel.wharf.example.com";
  process.env.INSTANCE_DOMAIN = "wharf.example.com";
});

/** Mint a real Auth.js session token the way the panel does. */
async function session(role: string, opts: { expired?: boolean } = {}) {
  return encode({
    token: { id: "u1", email: "ops@wharf.example.com", role },
    secret: SECRET,
    salt: COOKIE,
    maxAge: opts.expired ? -60 : 3600,
  });
}

function request(cookie?: string, headers: Record<string, string> = {}) {
  return new Request("https://panel.wharf.example.com/api/auth/verify", {
    headers: {
      ...(cookie ? { cookie } : {}),
      "x-forwarded-proto": "https",
      "x-forwarded-host": "studio-clienta.wharf.example.com",
      "x-forwarded-uri": "/project/default/editor",
      ...headers,
    },
  });
}

describe("GET /api/auth/verify — Traefik forwardAuth gate", () => {
  it("allows an admin session and forwards the user header", async () => {
    const res = await GET(request(`${COOKIE}=${await session("admin")}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Wharf-User")).toBe("ops@wharf.example.com");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("allows an operator session", async () => {
    const res = await GET(request(`${COOKIE}=${await session("operator")}`));
    expect(res.status).toBe(200);
  });

  it("denies a viewer — Studio can mutate data, panel viewers are read-only", async () => {
    const res = await GET(request(`${COOKIE}=${await session("viewer")}`));
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Wharf-User")).toBeNull();
  });

  it.each([
    ["no cookie at all", undefined],
    ["an unrelated cookie", "other=1"],
    ["a garbage token", `${COOKIE}=not-a-jwe`],
    ["an empty token", `${COOKIE}=`],
  ])("denies %s", async (_label, cookie) => {
    const res = await GET(request(cookie));
    expect(res.status).toBe(401);
  });

  it("denies an expired session", async () => {
    const res = await GET(request(`${COOKIE}=${await session("admin", { expired: true })}`));
    expect(res.status).toBe(401);
  });

  it("denies a token signed with a different secret", async () => {
    const foreign = await encode({
      token: { id: "u1", email: "x@y.z", role: "admin" },
      secret: randomBytes(32).toString("base64"),
      salt: COOKIE,
      maxAge: 3600,
    });
    const res = await GET(request(`${COOKIE}=${foreign}`));
    expect(res.status).toBe(401);
  });

  it("denies a token whose salt (cookie name) does not match", async () => {
    // Minted under a different cookie name ⇒ different derived key.
    const other = await encode({
      token: { id: "u1", email: "x@y.z", role: "admin" },
      secret: SECRET,
      salt: "some.other.cookie",
      maxAge: 3600,
    });
    const res = await GET(request(`${COOKIE}=${other}`));
    expect(res.status).toBe(401);
  });

  it("accepts the __Secure- cookie variant", async () => {
    const name = "__Secure-wharf.session";
    const token = await encode({
      token: { id: "u1", email: "ops@wharf.example.com", role: "admin" },
      secret: SECRET,
      salt: name,
      maxAge: 3600,
    });
    const res = await GET(request(`${name}=${token}`));
    expect(res.status).toBe(200);
  });

  it("sends the user back to the panel login with a returnTo on denial", async () => {
    const res = await GET(request());
    const location = res.headers.get("Location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.origin + url.pathname).toBe("https://panel.wharf.example.com/login");
    expect(url.searchParams.get("returnTo")).toBe(
      "https://studio-clienta.wharf.example.com/project/default/editor",
    );
  });

  it("still denies (without Location) when forwarded headers are absent", async () => {
    const bare = new Request("https://panel.wharf.example.com/api/auth/verify");
    const res = await GET(bare);
    expect(res.status).toBe(401);
  });

  it("drops returnTo instead of trusting it when x-forwarded-host is the panel's own host", async () => {
    // Exactly the bug seen live: a reverse proxy in front of the panel
    // rewrote x-forwarded-host to its own $host before this route saw it.
    const res = await GET(
      request(undefined, { "x-forwarded-host": "panel.wharf.example.com" }),
    );
    const location = res.headers.get("Location");
    expect(location).toBeTruthy();
    expect(new URL(location!).searchParams.has("returnTo")).toBe(false);
  });

  it("drops returnTo instead of trusting it when x-forwarded-host is outside INSTANCE_DOMAIN", async () => {
    // Would otherwise be an open redirect off the panel's own login screen.
    const res = await GET(
      request(undefined, { "x-forwarded-host": "evil.example.com" }),
    );
    const location = res.headers.get("Location");
    expect(location).toBeTruthy();
    expect(new URL(location!).searchParams.has("returnTo")).toBe(false);
  });

  it("accepts a bare instance API host (no studio- prefix) under INSTANCE_DOMAIN", async () => {
    const res = await GET(
      request(undefined, { "x-forwarded-host": "clienta.wharf.example.com" }),
    );
    const location = res.headers.get("Location");
    expect(new URL(location!).searchParams.get("returnTo")).toBe(
      "https://clienta.wharf.example.com/project/default/editor",
    );
  });

  it("fails closed when NEXTAUTH_SECRET is missing", async () => {
    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.AUTH_SECRET;
    const res = await GET(request(`${COOKIE}=${await session("admin")}`));
    process.env.NEXTAUTH_SECRET = saved;
    expect(res.status).toBe(401);
  });
});
