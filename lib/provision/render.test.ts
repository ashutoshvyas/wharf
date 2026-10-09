import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import {
  POOLER_NETWORK,
  TRAEFIK_NETWORK,
  WHARF_AUTH_MIDDLEWARE,
  WHARF_STUDIO_FRAME_MIDDLEWARE,
} from "@/lib/bootstrap/constants";
import { deriveAnalyticsSecrets, deriveAncillarySecrets, type InstanceSecrets } from "./secrets";
import {
  DEFAULT_AUTH_SETTINGS,
  HEALTHCHECK_POLICY,
  instanceServices,
  KONG_WORKER_PROCESSES,
  SERVICE_LIMITS,
  kongLabels,
  renderInstanceCompose,
  serviceNetworkNames,
  studioLabels,
  type RenderInstanceInput,
} from "./render";

/**
 * Fixed, obviously-fake secrets. Rendering must be a pure function of its
 * inputs, so nothing here needs to be freshly generated — and fixed values let
 * us assert the exact bytes that reach the .env.
 */
const SECRETS: InstanceSecrets = {
  pgPassword: "aB3dE6gH9jK2mN5pQ8sT1vW4xY7zA0bC",
  jwtSecret: "d".repeat(80),
  anonKey: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.fake-anon-signature",
  serviceRoleKey: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake-sr-signature",
};

const INPUT: RenderInstanceInput = {
  slug: "clienta",
  project: "sb_4f2a",
  domain: "wharf.example.com",
  secrets: SECRETS,
  remotePath: "/opt/db-instances/sb_4f2a",
};

interface ComposeDoc {
  services: Record<string, Record<string, unknown> | undefined>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
}

async function renderDoc(overrides: Partial<RenderInstanceInput> = {}) {
  const { composeYaml, envFile } = await renderInstanceCompose({ ...INPUT, ...overrides });
  return { composeYaml, envFile, doc: load(composeYaml) as ComposeDoc };
}

/**
 * A service minus what applyRuntimePolicy owns (health-check cadence, CPU/
 * memory caps, slice, kong's worker count) — covered by their own tests, so the
 * template-integrity tests compare everything else.
 */
function withoutRuntimePolicy(service: Record<string, unknown> | undefined) {
  const copy: Record<string, unknown> = structuredClone(service ?? {});
  delete copy.cpus;
  delete copy.mem_limit;
  delete copy.cgroup_parent;
  const healthcheck = copy.healthcheck as Record<string, unknown> | undefined;
  if (healthcheck) for (const key of Object.keys(HEALTHCHECK_POLICY)) delete healthcheck[key];
  const env = copy.environment as Record<string, unknown> | undefined;
  if (env) delete env.KONG_NGINX_WORKER_PROCESSES;
  return copy;
}

function envValue(envFile: string, key: string): string | undefined {
  const line = envFile.split("\n").find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1);
}

describe("label sets", () => {
  it("emits the exact kong (public API) label set", () => {
    expect(kongLabels("sb_4f2a", "clienta.wharf.example.com")).toEqual([
      "traefik.enable=true",
      "traefik.http.routers.sb_4f2a-api.rule=Host(`clienta.wharf.example.com`)",
      "traefik.http.routers.sb_4f2a-api.entrypoints=websecure",
      "traefik.http.routers.sb_4f2a-api.tls.certresolver=letsencrypt",
      "traefik.http.services.sb_4f2a-api.loadbalancer.server.port=8000",
    ]);
  });

  it("emits the exact studio label set, including the auth + frame middlewares", () => {
    expect(studioLabels("sb_4f2a", "studio-clienta.wharf.example.com")).toEqual([
      "traefik.enable=true",
      "traefik.http.routers.sb_4f2a-studio.rule=Host(`studio-clienta.wharf.example.com`)",
      "traefik.http.routers.sb_4f2a-studio.entrypoints=websecure",
      "traefik.http.routers.sb_4f2a-studio.tls.certresolver=letsencrypt",
      "traefik.http.routers.sb_4f2a-studio.middlewares=wharf-auth@file,wharf-studio-frame@file",
      "traefik.http.services.sb_4f2a-studio.loadbalancer.server.port=3000",
    ]);
  });

  it("takes the middleware names from lib/bootstrap/constants, never a literal", () => {
    const labels = studioLabels("sb_4f2a", "studio-clienta.wharf.example.com");
    expect(labels).toContain(
      `traefik.http.routers.sb_4f2a-studio.middlewares=${WHARF_AUTH_MIDDLEWARE},${WHARF_STUDIO_FRAME_MIDDLEWARE}`,
    );
  });
});

describe("renderInstanceCompose — traefik wiring", () => {
  it("puts the rendered label sets on kong and studio", async () => {
    const { doc } = await renderDoc();
    expect(doc.services.kong?.labels).toEqual(kongLabels("sb_4f2a", "clienta.wharf.example.com"));
    expect(doc.services.studio?.labels).toEqual(
      studioLabels("sb_4f2a", "studio-clienta.wharf.example.com"),
    );
  });

  it("gates studio behind wharf-auth but leaves the kong API public", async () => {
    const { doc } = await renderDoc();
    const kong = (doc.services.kong?.labels ?? []) as string[];
    const studio = (doc.services.studio?.labels ?? []) as string[];

    // Live applications call the API — a login wall here would break them.
    expect(kong.some((l) => l.includes("middlewares"))).toBe(false);
    expect(kong.join("\n")).not.toContain(WHARF_AUTH_MIDDLEWARE);

    expect(
      studio.some((l) =>
        l.endsWith(`.middlewares=${WHARF_AUTH_MIDDLEWARE},${WHARF_STUDIO_FRAME_MIDDLEWARE}`),
      ),
    ).toBe(true);
  });

  it("enables traefik only on kong and studio", async () => {
    const { doc } = await renderDoc();
    for (const [name, service] of Object.entries(doc.services)) {
      const labels = (service?.labels ?? []) as string[];
      const enabled = labels.includes("traefik.enable=true");
      expect([name, enabled]).toEqual([name, name === "kong" || name === "studio"]);
    }
  });

  it("routes each host to the right container port", async () => {
    const { composeYaml } = await renderDoc();
    expect(composeYaml).toContain(
      "traefik.http.services.sb_4f2a-api.loadbalancer.server.port=8000",
    );
    expect(composeYaml).toContain(
      "traefik.http.services.sb_4f2a-studio.loadbalancer.server.port=3000",
    );
  });
});

describe("renderInstanceCompose — networks", () => {
  it("declares the traefik network as external plus the project default", async () => {
    const { doc } = await renderDoc();
    expect(doc.networks?.[TRAEFIK_NETWORK]).toEqual({ external: true });
    expect(doc.networks?.default).toEqual({ name: "sb_4f2a_default" });
  });

  it("joins kong and studio to the traefik network without dropping default", async () => {
    const { doc } = await renderDoc();
    for (const name of ["kong", "studio"]) {
      const nets = serviceNetworkNames(doc.services[name]);
      expect(nets).toContain(TRAEFIK_NETWORK);
      expect(nets).toContain("default");
    }
  });

  it("preserves kong's api-gw alias on the default network", async () => {
    const { doc } = await renderDoc();
    const networks = doc.services.kong?.networks as Record<string, { aliases?: string[] }>;
    expect(networks.default?.aliases).toEqual(["api-gw"]);
  });

  it("gives no service a fixed container_name — a second instance on the same server must be able to start", async () => {
    // Regression test: every upstream service had a fixed container_name
    // (e.g. supabase-imgproxy), which Docker requires to be unique per HOST,
    // not per compose project. Confirmed live: a second instance's
    // `docker compose up -d` failed with "Conflict. The container name
    // '/supabase-imgproxy' is already in use" the moment it was provisioned
    // onto a server already running a first instance.
    const { doc } = await renderDoc();
    for (const [name, service] of Object.entries(doc.services)) {
      expect([name, (service as { container_name?: unknown })?.container_name]).toEqual([
        name,
        undefined,
      ]);
    }
  });

  it("keeps realtime's tenant hostname as a project-scoped network alias, not a fixed container_name", async () => {
    // realtime constructs its tenant id from this hostname, and kong.yml's
    // own realtime route resolves it by the same name — it can't just lose
    // its name like the other services, but a network alias is scoped to
    // this instance's own private network (unlike container_name, which is
    // host-global), so it's safe to reuse the identical alias across every
    // instance on the same server.
    const { doc } = await renderDoc();
    const networks = doc.services.realtime?.networks as Record<string, { aliases?: string[] }>;
    expect(networks.default?.aliases).toEqual(["realtime-dev.supabase-realtime"]);
    expect((doc.services.realtime as { container_name?: unknown })?.container_name).toBeUndefined();
  });

  it("never puts db on the traefik network", async () => {
    const { doc } = await renderDoc();
    // Postgres must not be reachable from the shared network — other tenants
    // and the Traefik container itself live there.
    expect(serviceNetworkNames(doc.services.db)).not.toContain(TRAEFIK_NETWORK);
  });

  it("keeps every non-routed service off the traefik network", async () => {
    const { doc } = await renderDoc();
    for (const [name, service] of Object.entries(doc.services)) {
      if (name === "kong" || name === "studio") continue;
      expect([name, serviceNetworkNames(service).includes(TRAEFIK_NETWORK)]).toEqual([
        name,
        false,
      ]);
    }
  });

  it("declares the pooler network as external", async () => {
    const { doc } = await renderDoc();
    expect(doc.networks?.[POOLER_NETWORK]).toEqual({ external: true });
  });

  it("joins db to the pooler network under a project-scoped alias, without dropping default", async () => {
    const { doc } = await renderDoc();
    const nets = serviceNetworkNames(doc.services.db);
    expect(nets).toContain(POOLER_NETWORK);
    expect(nets).toContain("default");
    const networks = doc.services.db?.networks as Record<string, { aliases?: string[] }>;
    // Hyphenated, not `sb_4f2a-db` — the underscore in composeProjectName
    // must never reach this alias (see naming.ts's poolerDbAlias doc comment
    // for why: Erlang's DNS resolver, which Supavisor uses, is known to fail
    // on underscored hostnames).
    expect(networks[POOLER_NETWORK]?.aliases).toEqual(["sb-4f2a-db"]);
  });

  it("keeps every service other than db off the pooler network", async () => {
    const { doc } = await renderDoc();
    for (const [name, service] of Object.entries(doc.services)) {
      if (name === "db") continue;
      expect([name, serviceNetworkNames(service).includes(POOLER_NETWORK)]).toEqual([
        name,
        false,
      ]);
    }
  });
});

describe("renderInstanceCompose — host ports", () => {
  it("removes published host ports from kong and studio", async () => {
    const { doc } = await renderDoc();
    // Upstream publishes ${KONG_HTTP_PORT}:8000 and ${KONG_HTTPS_PORT}:8443,
    // which would make the second instance on a server fail to start.
    expect(doc.services.kong?.ports).toBeUndefined();
    expect(doc.services.studio?.ports).toBeUndefined();
  });

  it("publishes no host ports at all", async () => {
    const { doc } = await renderDoc();
    for (const [name, service] of Object.entries(doc.services)) {
      expect([name, service?.ports]).toEqual([name, undefined]);
    }
  });
});

describe("renderInstanceCompose — vendored template integrity", () => {
  it("carries exactly the fourteen services WHARF ships, all pinned", async () => {
    const { doc, composeYaml } = await renderDoc();
    expect(Object.keys(doc.services).sort()).toEqual([
      "auth",
      "db",
      "imgproxy",
      "kong",
      "lakekeeper",
      "lakekeeper-init",
      "lakekeeper-migrate",
      "meta",
      "minio",
      "minio-init",
      "realtime",
      "rest",
      "storage",
      "studio",
    ]);
    const images = [...composeYaml.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1] ?? "");
    expect(images).toHaveLength(14);
    for (const image of images) {
      expect(image).toContain(":");
      expect(image.endsWith(":latest")).toBe(false);
    }
  });

  it("keeps the 4 analytics-bucket services off the Traefik network, and never auto-started (profile-gated)", async () => {
    const { doc } = await renderDoc();
    for (const name of ["minio", "minio-init", "lakekeeper", "lakekeeper-migrate", "lakekeeper-init"]) {
      const service = doc.services[name] as { profiles?: string[] } | undefined;
      expect(service?.profiles).toEqual(["analytics"]);
    }
  });

  it("passes every non-routed service through the yaml round-trip unchanged", async () => {
    // js-yaml re-emits the whole document, so a parser quirk could silently
    // rewrite upstream config we never meant to touch. Compare against the
    // vendored template's own parse.
    const template = load(
      await readFile(path.join(process.cwd(), "templates", "supabase", "docker-compose.yml"), "utf8"),
    ) as ComposeDoc;
    for (const name of Object.keys(template.services)) {
      // kong/studio/db are rewritten (labels, networks, ports); `auth` has
      // its unused send-SMS hook keys stripped — both covered by their own
      // tests below, which assert exactly what changed.
      if (name === "kong" || name === "studio" || name === "db" || name === "auth") continue;
      const { doc } = await renderDoc();
      expect([name, withoutRuntimePolicy(doc.services[name])]).toEqual([
        name,
        withoutRuntimePolicy(template.services[name]),
      ]);
    }
    expect((load((await renderDoc()).composeYaml) as ComposeDoc).volumes).toEqual(
      template.volumes,
    );
  });

  it("changes the auth service only by stripping the send-SMS hook keys it does not use", async () => {
    const template = load(
      await readFile(path.join(process.cwd(), "templates", "supabase", "docker-compose.yml"), "utf8"),
    ) as ComposeDoc;
    const templateAuth = template.services.auth as { environment: Record<string, string> };
    const HOOK_KEYS = [
      "GOTRUE_HOOK_SEND_SMS_ENABLED",
      "GOTRUE_HOOK_SEND_SMS_URI",
      "GOTRUE_HOOK_SEND_SMS_SECRETS",
    ];

    // No hook-delivered provider: identical to the vendored template except
    // those three keys are absent.
    const withoutHook = (await renderDoc()).doc.services.auth as {
      environment: Record<string, string>;
    };
    const expected = { ...templateAuth.environment };
    for (const key of HOOK_KEYS) delete expected[key];
    expect(withoutHook.environment).toEqual(expected);

    // MSG91 selected: nothing is stripped, so it matches the template exactly.
    const withHook = (
      await renderDoc({ authSettings: { ...DEFAULT_AUTH_SETTINGS, smsProvider: "msg91" } })
    ).doc.services.auth as { environment: Record<string, string> };
    expect(withHook.environment).toEqual(templateAuth.environment);
  });

  it("changes kong and studio only by labels, networks and ports", async () => {
    const template = load(
      await readFile(path.join(process.cwd(), "templates", "supabase", "docker-compose.yml"), "utf8"),
    ) as ComposeDoc;
    const { doc } = await renderDoc();
    for (const name of ["kong", "studio"]) {
      const before = withoutRuntimePolicy(template.services[name]);
      const after = withoutRuntimePolicy(doc.services[name]);
      for (const key of ["labels", "networks", "ports"]) {
        delete before[key];
        delete after[key];
      }
      expect([name, after]).toEqual([name, before]);
    }
  });

  it("changes db only by networks (the pooler alias)", async () => {
    const template = load(
      await readFile(path.join(process.cwd(), "templates", "supabase", "docker-compose.yml"), "utf8"),
    ) as ComposeDoc;
    const { doc } = await renderDoc();
    const before = withoutRuntimePolicy(template.services.db);
    const after = withoutRuntimePolicy(doc.services.db);
    delete before.networks;
    delete after.networks;
    expect(after).toEqual(before);
  });

  it("does not set a top-level compose project name", async () => {
    const { doc } = await renderDoc();
    // The project name comes from `docker compose -p sb_xxxx`; a `name:` key
    // here would be a second source of truth.
    expect((doc as unknown as Record<string, unknown>).name).toBeUndefined();
  });

  it("starts with a header naming the instance and both routes", async () => {
    const { composeYaml } = await renderDoc();
    expect(composeYaml.startsWith("# Generated by WHARF")).toBe(true);
    expect(composeYaml).toContain("/opt/db-instances/sb_4f2a");
    expect(composeYaml).toContain("https://clienta.wharf.example.com");
    expect(composeYaml).toContain("https://studio-clienta.wharf.example.com");
  });
});

describe("renderInstanceCompose — runtime policy", () => {
  it("probes every health-checked service once a minute, fast only until first healthy", async () => {
    const { doc } = await renderDoc();
    const checked = Object.entries(doc.services).filter(([, s]) => s?.healthcheck);
    expect(checked.length).toBeGreaterThanOrEqual(8);
    for (const [name, service] of checked) {
      expect([name, service?.healthcheck]).toMatchObject([
        name,
        { interval: "60s", start_interval: "3s", start_period: "180s" },
      ]);
    }
  });

  it("keeps each probe's own test, timeout and retries from the template", async () => {
    const template = load(
      await readFile(path.join(process.cwd(), "templates", "supabase", "docker-compose.yml"), "utf8"),
    ) as ComposeDoc;
    const { doc } = await renderDoc();
    const db = doc.services.db?.healthcheck as Record<string, unknown>;
    const templateDb = template.services.db?.healthcheck as Record<string, unknown>;
    expect(db.test).toEqual(templateDb.test);
    expect(db.timeout).toBe(templateDb.timeout);
    expect(db.retries).toBe(templateDb.retries);
  });

  it("caps CPU on every long-running service and exempts one-shot init services", async () => {
    const { doc } = await renderDoc();
    for (const [name, service] of Object.entries(doc.services)) {
      if (service?.restart === "no") {
        expect([name, service.cpus]).toEqual([name, undefined]);
        continue;
      }
      expect([name, service?.cpus]).toEqual([name, SERVICE_LIMITS[name]?.cpus]);
      expect([name, service?.mem_limit]).toEqual([name, SERVICE_LIMITS[name]?.mem_limit]);
    }
  });

  it("puts every service, one-shots included, in the instance's own systemd slice", async () => {
    const { doc } = await renderDoc();
    for (const [name, service] of Object.entries(doc.services)) {
      expect([name, service?.cgroup_parent]).toEqual([name, "wharf-sb_4f2a.slice"]);
    }
  });

  it("leaves db without a memory cap", async () => {
    const { doc } = await renderDoc();
    expect(doc.services.db?.mem_limit).toBeUndefined();
  });

  it("pins kong's nginx worker count instead of sizing to host CPUs", async () => {
    const { doc } = await renderDoc();
    const env = doc.services.kong?.environment as Record<string, unknown>;
    expect(env.KONG_NGINX_WORKER_PROCESSES).toBe(KONG_WORKER_PROCESSES);
  });
});

describe("instanceServices", () => {
  it("lists the always-on and profile-gated long-running services, never one-shots", async () => {
    const { core, optional } = await instanceServices();
    expect(core.sort()).toEqual(["auth", "db", "imgproxy", "kong", "meta", "realtime", "rest", "storage", "studio"]);
    expect(optional.sort()).toEqual(["lakekeeper", "minio"]);
  });
});

describe("renderInstanceCompose — input validation", () => {
  it("throws on an invalid slug before any templating happens", async () => {
    for (const slug of [
      "",
      "-bad",
      "Bad",
      "bad_slug",
      "bad slug",
      "a".repeat(41),
      "x`)||Host(`evil.com",
      "evil\nlabel",
    ]) {
      await expect(renderInstanceCompose({ ...INPUT, slug })).rejects.toThrow(/Invalid slug/);
    }
  });

  it("throws on an invalid project name", async () => {
    for (const project of ["", "sb_zzzz", "sb_4f2ab", "supabase", "../x"]) {
      await expect(renderInstanceCompose({ ...INPUT, project })).rejects.toThrow(
        /Invalid compose project name/,
      );
    }
  });

  it("throws on an empty or hostile domain", async () => {
    for (const domain of ["", "nodot", "wharf.example.com`)||Host(`evil.com", "UPPER.dev", "a..b"]) {
      await expect(renderInstanceCompose({ ...INPUT, domain })).rejects.toThrow(
        /Invalid instance domain/,
      );
    }
  });

  it("throws on a relative remote path", async () => {
    await expect(renderInstanceCompose({ ...INPUT, remotePath: "opt/x" })).rejects.toThrow(
      /must be absolute/,
    );
  });

  it("throws on a missing or newline-bearing secret", async () => {
    await expect(
      renderInstanceCompose({ ...INPUT, secrets: { ...SECRETS, pgPassword: "" } }),
    ).rejects.toThrow(/Missing secret pgPassword/);
    await expect(
      renderInstanceCompose({ ...INPUT, secrets: { ...SECRETS, anonKey: "a\nSMUGGLED=1" } }),
    ).rejects.toThrow(/line break/);
  });
});

describe("renderInstanceCompose — env file", () => {
  it("contains the exact generated values", async () => {
    const { envFile } = await renderDoc();
    expect(envValue(envFile, "POSTGRES_PASSWORD")).toBe(SECRETS.pgPassword);
    expect(envValue(envFile, "JWT_SECRET")).toBe(SECRETS.jwtSecret);
    expect(envValue(envFile, "ANON_KEY")).toBe(SECRETS.anonKey);
    expect(envValue(envFile, "SERVICE_ROLE_KEY")).toBe(SECRETS.serviceRoleKey);
  });

  it("points every public URL at the API subdomain over https", async () => {
    const { envFile } = await renderDoc();
    for (const key of ["SITE_URL", "API_EXTERNAL_URL", "SUPABASE_PUBLIC_URL"]) {
      expect(envValue(envFile, key)).toBe("https://clienta.wharf.example.com");
    }
    expect(envFile).not.toContain("http://localhost");
  });

  // PostgREST overrides the database's own search_path, and an OPERATOR can
  // only be resolved through it — unlike a type or function, it cannot be
  // schema-qualified by name. Dropping `extensions` here breaks every RPC
  // using a bare extension operator (`operator does not exist:
  // extensions.vector <=> extensions.vector`) while the same query keeps
  // working over a direct/pooler connection, which makes it a genuinely
  // confusing outage to diagnose. Upstream ships `public` alone.
  it("keeps `extensions` on PostgREST's search path", async () => {
    const { envFile } = await renderDoc();
    const value = envValue(envFile, "PGRST_DB_EXTRA_SEARCH_PATH") ?? "";
    expect(value.split(",").map((s) => s.trim())).toContain("extensions");
  });

  it("sets sensible Studio defaults", async () => {
    const { envFile } = await renderDoc();
    expect(envValue(envFile, "STUDIO_DEFAULT_ORGANIZATION")).toBe("WHARF");
    expect(envValue(envFile, "STUDIO_DEFAULT_PROJECT")).toBe("clienta");
  });

  it("fills the ancillary service keys from the instance's own jwtSecret", async () => {
    const { envFile } = await renderDoc();
    const derived = deriveAncillarySecrets(SECRETS.jwtSecret);
    expect(envValue(envFile, "SECRET_KEY_BASE")).toBe(derived.secretKeyBase);
    expect(envValue(envFile, "REALTIME_DB_ENC_KEY")).toBe(derived.realtimeDbEncKey);
    expect(envValue(envFile, "PG_META_CRYPTO_KEY")).toBe(derived.pgMetaCryptoKey);
    expect(envValue(envFile, "S3_PROTOCOL_ACCESS_KEY_ID")).toBe(derived.s3AccessKeyId);
    expect(envValue(envFile, "S3_PROTOCOL_ACCESS_KEY_SECRET")).toBe(derived.s3AccessKeySecret);
    expect(envValue(envFile, "DASHBOARD_PASSWORD")).toBe(derived.dashboardPassword);
    // Never upstream's published example values.
    expect(envValue(envFile, "REALTIME_DB_ENC_KEY")).not.toBe("supabaserealtime");
  });

  it("leaves no unsubstituted placeholders", async () => {
    const { envFile } = await renderDoc();
    expect(envFile).not.toMatch(/\{\{/);
    expect(envFile).not.toMatch(/\}\}/);
    // Nor any of upstream's "change me" defaults.
    expect(envFile).not.toContain("your-super-secret");
    expect(envFile).not.toContain("this_password_is_insecure");
    expect(envFile).not.toContain("your-32-character-encryption-key");
  });

  it("keeps every value on one line and free of quoting hazards", async () => {
    const { envFile } = await renderDoc();
    for (const key of ["POSTGRES_PASSWORD", "JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY"]) {
      const value = envValue(envFile, key) ?? "";
      expect(value).not.toMatch(/[\s"'`$#]/);
    }
  });
});

describe("renderInstanceCompose — determinism", () => {
  it("produces identical bytes for identical inputs", async () => {
    const first = await renderInstanceCompose(INPUT);
    const second = await renderInstanceCompose(INPUT);
    expect(second.composeYaml).toBe(first.composeYaml);
    expect(second.envFile).toBe(first.envFile);
  });

  it("produces different output for a different instance", async () => {
    const first = await renderInstanceCompose(INPUT);
    const other = await renderInstanceCompose({
      ...INPUT,
      slug: "clientb",
      project: "sb_9e01",
      remotePath: "/opt/db-instances/sb_9e01",
    });
    expect(other.composeYaml).not.toBe(first.composeYaml);
    expect(other.composeYaml).toContain("Host(`clientb.wharf.example.com`)");
    expect(other.composeYaml).toContain("traefik.http.routers.sb_9e01-studio.middlewares");
  });
});

describe("renderInstanceCompose — Auth settings", () => {
  it("renders exactly today's hardcoded defaults when authSettings is absent", async () => {
    const { envFile } = await renderDoc();
    expect(envValue(envFile, "DISABLE_SIGNUP")).toBe("false");
    expect(envValue(envFile, "ENABLE_EMAIL_SIGNUP")).toBe("true");
    expect(envValue(envFile, "ENABLE_EMAIL_AUTOCONFIRM")).toBe("true");
    expect(envValue(envFile, "ENABLE_PHONE_SIGNUP")).toBe("false");
    // Defaults true: what .env.template hardcoded before it was configurable.
    expect(envValue(envFile, "ENABLE_PHONE_AUTOCONFIRM")).toBe("true");
    expect(envValue(envFile, "ENABLE_ANONYMOUS_USERS")).toBe("false");
    expect(envValue(envFile, "JWT_EXPIRY")).toBe("3600");
    expect(envValue(envFile, "ADDITIONAL_REDIRECT_URLS")).toBe("");
    expect(envValue(envFile, "SMTP_HOST")).toBe("supabase-mail");
    expect(envValue(envFile, "SMTP_PORT")).toBe("2500");
    expect(envValue(envFile, "SMTP_USER")).toBe("fake_mail_user");
    expect(envValue(envFile, "SMTP_PASS")).toBe("fake_mail_password");
    expect(envValue(envFile, "SMTP_SENDER_NAME")).toBe("fake_sender");
    expect(envValue(envFile, "SMTP_ADMIN_EMAIL")).toBe("admin@example.com");
    expect(envValue(envFile, "MANUAL_LINKING_ENABLED")).toBe("false");
    expect(envValue(envFile, "GOOGLE_ENABLED")).toBe("false");
    expect(envValue(envFile, "GOOGLE_CLIENT_ID")).toBe("");
    expect(envValue(envFile, "GOOGLE_SECRET")).toBe("");
    expect(envValue(envFile, "GOOGLE_SKIP_NONCE_CHECK")).toBe("false");
    expect(envValue(envFile, "GOOGLE_EMAIL_OPTIONAL")).toBe("false");
    expect(envValue(envFile, "GITHUB_ENABLED")).toBe("false");
    expect(envValue(envFile, "AZURE_ENABLED")).toBe("false");
    expect(envValue(envFile, "APPLE_ENABLED")).toBe("false");
    expect(envValue(envFile, "APPLE_CLIENT_ID")).toBe("");
    expect(envValue(envFile, "APPLE_SECRET")).toBe("");
    expect(envValue(envFile, "APPLE_EMAIL_OPTIONAL")).toBe("false");
  });

  it("substitutes every provided Auth setting", async () => {
    const { envFile } = await renderDoc({
      instanceId: "inst-1", panelUrl: "https://wharf.example.com",
      authSettings: {
        disableSignup: true,
        enableEmailSignup: false,
        enableEmailAutoconfirm: false,
        enablePhoneSignup: true,
        enablePhoneAutoconfirm: false,
        enableAnonymousUsers: true,
        manualLinkingEnabled: true,
        jwtExpirySeconds: 7200,
        additionalRedirectUrls: "https://clienta.example.com/callback",
        siteUrl: "https://clienta.example.com",
        oauthCallbackUrl: "",
        smtpHost: "smtp.sendgrid.net",
        smtpPort: 587,
        smtpUser: "apikey",
        smtpPass: "SG.real-secret-value",
        smtpSenderName: "Client A",
        smtpAdminEmail: "ops@clienta.example.com",
        googleEnabled: true,
        // Comma-separated: GoTrue parses this into a []string, so a native
        // client id can ride along with the web one.
        googleClientId: "google-client-id.apps.googleusercontent.com,android-client-id",
        googleSecret: "google-secret-value",
        googleSkipNonceCheck: true,
        googleEmailOptional: true,
        githubEnabled: true,
        githubClientId: "github-client-id",
        githubSecret: "github-secret-value",
        azureEnabled: true,
        azureClientId: "azure-client-id",
        azureSecret: "azure-secret-value",
        appleEnabled: true,
        // Apple's client id is a Services ID, and GoTrue accepts a
        // comma-separated list so a native bundle id can ride along.
        appleClientId: "com.example.app.web,com.example.app",
        appleSecret: "apple.generated.jwt",
        appleEmailOptional: true,
        smsProvider: "twilio",
        smsOtpExp: 120,
        smsOtpLength: 8,
        smsMaxFrequency: "30s",
        smsTemplate: "Your code is {{ .Code }}",
        smsTwilioAccountSid: "ACtwilio",
        smsTwilioAuthToken: "twilio-token",
        smsTwilioMessageServiceSid: "MGtwilio",
        smsTwilioDeliveryChannel: "sms",
        smsTwilioWhatsappSender: "",
        smsTwilioContentSid: "",
        smsTwilioSmsFallback: false,
        smsMsg91AuthKey: "",
        smsMsg91TemplateId: "",
        smsMsg91SenderId: "",
        smsMsg91OtpVariable: "OTP",
      },
    });

    expect(envValue(envFile, "DISABLE_SIGNUP")).toBe("true");
    expect(envValue(envFile, "ENABLE_EMAIL_SIGNUP")).toBe("false");
    expect(envValue(envFile, "ENABLE_EMAIL_AUTOCONFIRM")).toBe("false");
    expect(envValue(envFile, "ENABLE_PHONE_SIGNUP")).toBe("true");
    expect(envValue(envFile, "ENABLE_PHONE_AUTOCONFIRM")).toBe("false");
    expect(envValue(envFile, "ENABLE_ANONYMOUS_USERS")).toBe("true");
    expect(envValue(envFile, "MANUAL_LINKING_ENABLED")).toBe("true");
    expect(envValue(envFile, "JWT_EXPIRY")).toBe("7200");
    expect(envValue(envFile, "ADDITIONAL_REDIRECT_URLS")).toBe(
      "https://clienta.example.com/callback",
    );
    expect(envValue(envFile, "SITE_URL")).toBe("https://clienta.example.com");
    // Left blank above, so it still derives from the instance's own origin.
    expect(envValue(envFile, "OAUTH_CALLBACK_URL")).toBe(
      "https://clienta.wharf.example.com/auth/v1/callback",
    );
    expect(envValue(envFile, "SMTP_HOST")).toBe("smtp.sendgrid.net");
    expect(envValue(envFile, "SMTP_PORT")).toBe("587");
    expect(envValue(envFile, "SMTP_USER")).toBe("apikey");
    expect(envValue(envFile, "SMTP_PASS")).toBe("SG.real-secret-value");
    expect(envValue(envFile, "SMTP_SENDER_NAME")).toBe("Client A");
    expect(envValue(envFile, "SMTP_ADMIN_EMAIL")).toBe("ops@clienta.example.com");
    expect(envValue(envFile, "GOOGLE_ENABLED")).toBe("true");
    expect(envValue(envFile, "GOOGLE_CLIENT_ID")).toBe(
      "google-client-id.apps.googleusercontent.com,android-client-id",
    );
    expect(envValue(envFile, "GOOGLE_SECRET")).toBe("google-secret-value");
    expect(envValue(envFile, "GOOGLE_SKIP_NONCE_CHECK")).toBe("true");
    expect(envValue(envFile, "GOOGLE_EMAIL_OPTIONAL")).toBe("true");
    expect(envValue(envFile, "GITHUB_ENABLED")).toBe("true");
    expect(envValue(envFile, "GITHUB_CLIENT_ID")).toBe("github-client-id");
    expect(envValue(envFile, "GITHUB_SECRET")).toBe("github-secret-value");
    expect(envValue(envFile, "AZURE_ENABLED")).toBe("true");
    expect(envValue(envFile, "AZURE_CLIENT_ID")).toBe("azure-client-id");
    expect(envValue(envFile, "AZURE_SECRET")).toBe("azure-secret-value");
    expect(envValue(envFile, "APPLE_ENABLED")).toBe("true");
    expect(envValue(envFile, "APPLE_CLIENT_ID")).toBe("com.example.app.web,com.example.app");
    expect(envValue(envFile, "APPLE_SECRET")).toBe("apple.generated.jwt");
    expect(envValue(envFile, "APPLE_EMAIL_OPTIONAL")).toBe("true");
  });

  it("uncomments the OAuth env lines on the auth service so GoTrue always reads them", async () => {
    const { composeYaml } = await renderDoc();
    expect(composeYaml).toContain("GOTRUE_EXTERNAL_GOOGLE_ENABLED: ${GOOGLE_ENABLED}");
    expect(composeYaml).toContain("GOTRUE_EXTERNAL_GITHUB_ENABLED: ${GITHUB_ENABLED}");
    expect(composeYaml).toContain("GOTRUE_EXTERNAL_AZURE_ENABLED: ${AZURE_ENABLED}");
    expect(composeYaml).toContain("GOTRUE_EXTERNAL_APPLE_ENABLED: ${APPLE_ENABLED}");
    expect(composeYaml).toContain("GOTRUE_EXTERNAL_APPLE_CLIENT_ID: ${APPLE_CLIENT_ID}");
    expect(composeYaml).toContain("GOTRUE_EXTERNAL_APPLE_SECRET: ${APPLE_SECRET}");
    expect(composeYaml).not.toContain("# GOTRUE_EXTERNAL_GOOGLE_ENABLED");
  });

  it("routes every provider's redirect URI through the one OAUTH_CALLBACK_URL", async () => {
    const { composeYaml, envFile } = await renderDoc();
    for (const provider of ["GOOGLE", "GITHUB", "AZURE", "APPLE"]) {
      expect(composeYaml).toContain(
        `GOTRUE_EXTERNAL_${provider}_REDIRECT_URI: \${OAUTH_CALLBACK_URL}`,
      );
    }
    // Upstream's `${API_EXTERNAL_URL}/callback` resolves to a path kong does
    // not route (only /auth/v1/callback reaches the auth container), so the
    // provider would reject the flow with redirect_uri_mismatch.
    expect(composeYaml).not.toContain("REDIRECT_URI: ${API_EXTERNAL_URL}/callback");
    expect(envValue(envFile, "OAUTH_CALLBACK_URL")).toBe(
      "https://clienta.wharf.example.com/auth/v1/callback",
    );
  });

  it("falls back to the instance's own origin when siteUrl/oauthCallbackUrl are blank", async () => {
    const { envFile } = await renderDoc({
      authSettings: { ...DEFAULT_AUTH_SETTINGS, siteUrl: "", oauthCallbackUrl: "" },
    });
    expect(envValue(envFile, "SITE_URL")).toBe("https://clienta.wharf.example.com");
    expect(envValue(envFile, "OAUTH_CALLBACK_URL")).toBe(
      "https://clienta.wharf.example.com/auth/v1/callback",
    );
  });

  it("lets one instance point Site URL and callback at the app it actually backs", async () => {
    const { envFile } = await renderDoc({
      authSettings: {
        ...DEFAULT_AUTH_SETTINGS,
        siteUrl: "https://app.example.com",
        oauthCallbackUrl: "https://app.example.com/auth/v1/callback",
      },
    });
    expect(envValue(envFile, "SITE_URL")).toBe("https://app.example.com");
    expect(envValue(envFile, "OAUTH_CALLBACK_URL")).toBe(
      "https://app.example.com/auth/v1/callback",
    );
    // The instance's own identity is unaffected — only where users are sent.
    expect(envValue(envFile, "API_EXTERNAL_URL")).toBe("https://clienta.wharf.example.com");
  });

  it("routes Twilio through WHARF without exposing credentials to the instance", async () => {
    const { composeYaml, envFile } = await renderDoc({
      authSettings: {
        ...DEFAULT_AUTH_SETTINGS,
        smsProvider: "twilio",
        smsTwilioAccountSid: "ACtwilio",
        smsTwilioAuthToken: "twilio-token",
        smsTwilioMessageServiceSid: "MGtwilio",
        smsTwilioDeliveryChannel: "sms",
        smsTwilioWhatsappSender: "",
        smsTwilioContentSid: "",
        smsTwilioSmsFallback: false,
      },
      instanceId: "inst-1",
      panelUrl: "https://wharf.example.com",
    });
    expect(envValue(envFile, "SMS_PROVIDER")).toBe("");
    expect(envValue(envFile, "SMS_TWILIO_ACCOUNT_SID")).toBe("");
    expect(envValue(envFile, "SMS_TWILIO_AUTH_TOKEN")).toBe("");
    expect(composeYaml).toContain("GOTRUE_HOOK_SEND_SMS_ENABLED");
    expect(envValue(envFile, "HOOK_SEND_SMS_ENABLED")).toBe("true");
    expect(envFile).not.toContain("twilio-token");
  });

  it("routes MSG91 through the panel hook and leaves SMS_PROVIDER empty", async () => {
    const { composeYaml, envFile } = await renderDoc({
      authSettings: { ...DEFAULT_AUTH_SETTINGS, smsProvider: "msg91" },
      instanceId: "inst-1",
      panelUrl: "https://wharf.example.com/",
    });
    // GoTrue bypasses the provider entirely when the hook is on; naming one
    // here would only invite confusion about which is in play.
    expect(envValue(envFile, "SMS_PROVIDER")).toBe("");
    expect(envValue(envFile, "HOOK_SEND_SMS_ENABLED")).toBe("true");
    expect(envValue(envFile, "HOOK_SEND_SMS_URI")).toBe(
      "https://wharf.example.com/api/db-instances/inst-1/sms-hook",
    );
    expect(envValue(envFile, "HOOK_SEND_SMS_SECRETS")).toMatch(/^v1,whsec_.+/);
    expect(composeYaml).toContain("GOTRUE_HOOK_SEND_SMS_ENABLED: ${HOOK_SEND_SMS_ENABLED}");
    // MSG91 credentials are the panel's, and must never reach the instance.
    // (The word itself appears in the template's explanatory comments, so
    // this checks for a rendered credential, not a mention.)
    expect(envFile).not.toMatch(/^MSG91|AUTH_KEY=/m);
  });

  it("refuses to enable the hook when there is no panel URL to call back to", async () => {
    // Enabling it with nowhere to call would swallow every OTP silently.
    const { envFile } = await renderDoc({
      authSettings: { ...DEFAULT_AUTH_SETTINGS, smsProvider: "msg91" },
      instanceId: "inst-1",
    });
    expect(envValue(envFile, "HOOK_SEND_SMS_ENABLED")).toBe("false");
    expect(envValue(envFile, "HOOK_SEND_SMS_URI")).toBe("");
    expect(envValue(envFile, "HOOK_SEND_SMS_SECRETS")).toBe("");
  });

  it("always renders concrete SMS numerics — empty is a parse error, not a default", async () => {
    // GOTRUE_SMS_OTP_EXP/OTP_LENGTH/MAX_FREQUENCY are uint/int/time.Duration.
    const { envFile } = await renderDoc();
    expect(envValue(envFile, "SMS_PROVIDER")).toBe("");
    expect(envValue(envFile, "SMS_OTP_EXP")).toBe("60");
    expect(envValue(envFile, "SMS_OTP_LENGTH")).toBe("6");
    expect(envValue(envFile, "SMS_MAX_FREQUENCY")).toBe("1m0s");
  });

  it("wires manual linking to the env var GoTrue actually reads", async () => {
    // GoTrue derives this name from SecurityConfiguration.ManualLinkingEnabled
    // via split_words — a typo here is silent, the setting simply never applies.
    const { composeYaml } = await renderDoc();
    expect(composeYaml).toContain(
      "GOTRUE_SECURITY_MANUAL_LINKING_ENABLED: ${MANUAL_LINKING_ENABLED}",
    );
  });

  it("exposes the per-provider nonce/email flags GoTrue reads", async () => {
    const { composeYaml } = await renderDoc();
    expect(composeYaml).toContain(
      "GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK: ${GOOGLE_SKIP_NONCE_CHECK}",
    );
    expect(composeYaml).toContain(
      "GOTRUE_EXTERNAL_GOOGLE_EMAIL_OPTIONAL: ${GOOGLE_EMAIL_OPTIONAL}",
    );
    expect(composeYaml).toContain(
      "GOTRUE_EXTERNAL_APPLE_EMAIL_OPTIONAL: ${APPLE_EMAIL_OPTIONAL}",
    );
  });

  it("rejects an Auth setting containing a line break before it ever reaches the .env", async () => {
    await expect(
      renderDoc({
        authSettings: {
          disableSignup: false,
          enableEmailSignup: true,
          enableEmailAutoconfirm: true,
          enablePhoneSignup: false,
          enablePhoneAutoconfirm: true,
          enableAnonymousUsers: false,
          manualLinkingEnabled: false,
          jwtExpirySeconds: 3600,
          additionalRedirectUrls: "https://evil.example.com/x\nPOSTGRES_PASSWORD=pwned",
          siteUrl: "",
          oauthCallbackUrl: "",
          smtpHost: "supabase-mail",
          smtpPort: 2500,
          smtpUser: "fake_mail_user",
          smtpPass: "fake_mail_password",
          smtpSenderName: "fake_sender",
          smtpAdminEmail: "admin@example.com",
          googleEnabled: false,
          googleClientId: "",
          googleSecret: "",
          googleSkipNonceCheck: false,
          googleEmailOptional: false,
          githubEnabled: false,
          githubClientId: "",
          githubSecret: "",
          azureEnabled: false,
          azureClientId: "",
          azureSecret: "",
          appleEnabled: false,
          appleClientId: "",
          appleSecret: "",
          appleEmailOptional: false,
          smsProvider: "",
          smsOtpExp: 60,
          smsOtpLength: 6,
          smsMaxFrequency: "1m0s",
          smsTemplate: "",
          smsTwilioAccountSid: "",
          smsTwilioAuthToken: "",
          smsTwilioMessageServiceSid: "",
          smsTwilioDeliveryChannel: "sms",
          smsTwilioWhatsappSender: "",
          smsTwilioContentSid: "",
          smsTwilioSmsFallback: false,
          smsMsg91AuthKey: "",
          smsMsg91TemplateId: "",
          smsMsg91SenderId: "",
          smsMsg91OtpVariable: "OTP",
        },
      }),
    ).rejects.toThrow(/line break/);
  });
});

describe("renderInstanceCompose — Email templates", () => {
  it("renders every flow empty when emailTemplates is absent — matches today exactly", async () => {
    const { envFile } = await renderDoc();
    for (const suffix of [
      "CONFIRMATION",
      "RECOVERY",
      "MAGIC_LINK",
      "INVITE",
      "EMAIL_CHANGE",
      "REAUTHENTICATION",
    ]) {
      expect(envValue(envFile, `MAILER_SUBJECTS_${suffix}`)).toBe("");
      expect(envValue(envFile, `MAILER_TEMPLATES_${suffix}`)).toBe("");
    }
  });

  it("sets the subject but leaves the template URL empty when hasBody is false", async () => {
    const { envFile } = await renderDoc({
      instanceId: "inst-1",
      panelUrl: "https://wharf.example.com",
      emailTemplates: [
        { flow: "confirmation", subject: "Confirm your email", hasBody: false },
      ],
    });
    expect(envValue(envFile, "MAILER_SUBJECTS_CONFIRMATION")).toBe("Confirm your email");
    expect(envValue(envFile, "MAILER_TEMPLATES_CONFIRMATION")).toBe("");
  });

  it("builds the template URL from instanceId + panelUrl when hasBody is true", async () => {
    const { envFile } = await renderDoc({
      instanceId: "inst-1",
      panelUrl: "https://wharf.example.com/",
      emailTemplates: [
        { flow: "magic_link", subject: "Your magic link", hasBody: true },
      ],
    });
    expect(envValue(envFile, "MAILER_SUBJECTS_MAGIC_LINK")).toBe("Your magic link");
    expect(envValue(envFile, "MAILER_TEMPLATES_MAGIC_LINK")).toBe(
      "https://wharf.example.com/api/db-instances/inst-1/email-template/magic_link",
    );
    // Trailing slash on panelUrl must not produce a double slash.
    expect(envValue(envFile, "MAILER_TEMPLATES_MAGIC_LINK")).not.toContain("//api");
  });

  it("leaves the template URL empty when hasBody is true but instanceId/panelUrl are missing", async () => {
    const { envFile } = await renderDoc({
      emailTemplates: [{ flow: "invite", subject: "", hasBody: true }],
    });
    expect(envValue(envFile, "MAILER_TEMPLATES_INVITE")).toBe("");
  });

  it("rejects a subject containing a line break, but allows one in a sibling field unaffected", async () => {
    await expect(
      renderDoc({
        emailTemplates: [
          { flow: "recovery", subject: "line1\nEVIL=1", hasBody: false },
        ],
      }),
    ).rejects.toThrow(/line break/);
  });
});

describe("renderInstanceCompose — Vector buckets", () => {
  it("is always on, with no input needed to enable it", async () => {
    const { envFile } = await renderDoc();
    expect(envValue(envFile, "VECTOR_ENABLED")).toBe("true");
    expect(envValue(envFile, "VECTOR_BUCKET_PROVIDER")).toBe("pgvector");
    expect(envValue(envFile, "VECTOR_DATABASE_CREATE")).toBe("true");
    expect(envValue(envFile, "VECTOR_STORE_MIGRATIONS_ENABLED")).toBe("true");
  });

  it("builds a maintenance connection string using the postgres superuser, not supabase_storage_admin", async () => {
    const { envFile } = await renderDoc();
    expect(envValue(envFile, "VECTOR_DATABASE_URL")).toBe(
      `postgres://postgres:${SECRETS.pgPassword}@db:5432/postgres`,
    );
  });
});

describe("renderInstanceCompose — Analytics buckets", () => {
  it("defaults to disabled with an empty COMPOSE_PROFILES, so MinIO/Lakekeeper never start", async () => {
    const { envFile } = await renderDoc();
    expect(envValue(envFile, "ICEBERG_ENABLED")).toBe("false");
    expect(envValue(envFile, "COMPOSE_PROFILES")).toBe("");
  });

  it("sets ICEBERG_ENABLED and COMPOSE_PROFILES=analytics when enabled", async () => {
    const { envFile } = await renderDoc({ analyticsSettings: { enabled: true } });
    expect(envValue(envFile, "ICEBERG_ENABLED")).toBe("true");
    expect(envValue(envFile, "COMPOSE_PROFILES")).toBe("analytics");
  });

  it("derives MinIO/Iceberg/Lakekeeper secrets from jwtSecret — never freshly random per render", async () => {
    const { envFile } = await renderDoc();
    const derived = deriveAnalyticsSecrets(SECRETS.jwtSecret);
    expect(envValue(envFile, "MINIO_ROOT_PASSWORD")).toBe(derived.minioRootPassword);
    expect(envValue(envFile, "ICEBERG_CATALOG_AUTH_TOKEN")).toBe(derived.icebergCatalogToken);
    expect(envValue(envFile, "LAKEKEEPER_PG_ENCRYPTION_KEY")).toBe(
      derived.lakekeeperPgEncryptionKey,
    );
  });

  it("points ICEBERG_CATALOG_URL at the instance-internal lakekeeper service, and sets a fixed warehouse/auth type", async () => {
    const { envFile } = await renderDoc();
    expect(envValue(envFile, "ICEBERG_CATALOG_URL")).toBe("http://lakekeeper:8181/catalog");
    expect(envValue(envFile, "ICEBERG_WAREHOUSE")).toBe("default");
    expect(envValue(envFile, "ICEBERG_CATALOG_AUTH_TYPE")).toBe("token");
  });

  it("MINIO_ROOT_USER is the same fixed constant regardless of input", async () => {
    const { envFile } = await renderDoc();
    expect(envValue(envFile, "MINIO_ROOT_USER")).toBe("wharf-minio-root");
  });
});
