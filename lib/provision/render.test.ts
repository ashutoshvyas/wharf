import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import {
  TRAEFIK_NETWORK,
  WHARF_AUTH_MIDDLEWARE,
  WHARF_STUDIO_FRAME_MIDDLEWARE,
} from "@/lib/bootstrap/constants";
import { deriveAncillarySecrets, type InstanceSecrets } from "./secrets";
import {
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
  it("carries exactly the nine services WHARF ships, all pinned", async () => {
    const { doc, composeYaml } = await renderDoc();
    expect(Object.keys(doc.services).sort()).toEqual([
      "auth",
      "db",
      "imgproxy",
      "kong",
      "meta",
      "realtime",
      "rest",
      "storage",
      "studio",
    ]);
    const images = [...composeYaml.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1] ?? "");
    expect(images).toHaveLength(9);
    for (const image of images) {
      expect(image).toContain(":");
      expect(image.endsWith(":latest")).toBe(false);
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
      if (name === "kong" || name === "studio") continue;
      const { doc } = await renderDoc();
      expect([name, doc.services[name]]).toEqual([name, template.services[name]]);
    }
    expect((load((await renderDoc()).composeYaml) as ComposeDoc).volumes).toEqual(
      template.volumes,
    );
  });

  it("changes kong and studio only by labels, networks and ports", async () => {
    const template = load(
      await readFile(path.join(process.cwd(), "templates", "supabase", "docker-compose.yml"), "utf8"),
    ) as ComposeDoc;
    const { doc } = await renderDoc();
    for (const name of ["kong", "studio"]) {
      const before = { ...(template.services[name] ?? {}) };
      const after = { ...(doc.services[name] ?? {}) };
      for (const key of ["labels", "networks", "ports"]) {
        delete before[key];
        delete after[key];
      }
      expect([name, after]).toEqual([name, before]);
    }
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
    expect(envValue(envFile, "ENABLE_ANONYMOUS_USERS")).toBe("false");
    expect(envValue(envFile, "JWT_EXPIRY")).toBe("3600");
    expect(envValue(envFile, "ADDITIONAL_REDIRECT_URLS")).toBe("");
    expect(envValue(envFile, "SMTP_HOST")).toBe("supabase-mail");
    expect(envValue(envFile, "SMTP_PORT")).toBe("2500");
    expect(envValue(envFile, "SMTP_USER")).toBe("fake_mail_user");
    expect(envValue(envFile, "SMTP_PASS")).toBe("fake_mail_password");
    expect(envValue(envFile, "SMTP_SENDER_NAME")).toBe("fake_sender");
    expect(envValue(envFile, "SMTP_ADMIN_EMAIL")).toBe("admin@example.com");
    expect(envValue(envFile, "GOOGLE_ENABLED")).toBe("false");
    expect(envValue(envFile, "GOOGLE_CLIENT_ID")).toBe("");
    expect(envValue(envFile, "GOOGLE_SECRET")).toBe("");
    expect(envValue(envFile, "GITHUB_ENABLED")).toBe("false");
    expect(envValue(envFile, "AZURE_ENABLED")).toBe("false");
  });

  it("substitutes every provided Auth setting", async () => {
    const { envFile } = await renderDoc({
      authSettings: {
        disableSignup: true,
        enableEmailSignup: false,
        enableEmailAutoconfirm: false,
        enablePhoneSignup: true,
        enableAnonymousUsers: true,
        jwtExpirySeconds: 7200,
        additionalRedirectUrls: "https://clienta.example.com/callback",
        smtpHost: "smtp.sendgrid.net",
        smtpPort: 587,
        smtpUser: "apikey",
        smtpPass: "SG.real-secret-value",
        smtpSenderName: "Client A",
        smtpAdminEmail: "ops@clienta.example.com",
        googleEnabled: true,
        googleClientId: "google-client-id.apps.googleusercontent.com",
        googleSecret: "google-secret-value",
        githubEnabled: true,
        githubClientId: "github-client-id",
        githubSecret: "github-secret-value",
        azureEnabled: true,
        azureClientId: "azure-client-id",
        azureSecret: "azure-secret-value",
      },
    });

    expect(envValue(envFile, "DISABLE_SIGNUP")).toBe("true");
    expect(envValue(envFile, "ENABLE_EMAIL_SIGNUP")).toBe("false");
    expect(envValue(envFile, "ENABLE_EMAIL_AUTOCONFIRM")).toBe("false");
    expect(envValue(envFile, "ENABLE_PHONE_SIGNUP")).toBe("true");
    expect(envValue(envFile, "ENABLE_ANONYMOUS_USERS")).toBe("true");
    expect(envValue(envFile, "JWT_EXPIRY")).toBe("7200");
    expect(envValue(envFile, "ADDITIONAL_REDIRECT_URLS")).toBe(
      "https://clienta.example.com/callback",
    );
    expect(envValue(envFile, "SMTP_HOST")).toBe("smtp.sendgrid.net");
    expect(envValue(envFile, "SMTP_PORT")).toBe("587");
    expect(envValue(envFile, "SMTP_USER")).toBe("apikey");
    expect(envValue(envFile, "SMTP_PASS")).toBe("SG.real-secret-value");
    expect(envValue(envFile, "SMTP_SENDER_NAME")).toBe("Client A");
    expect(envValue(envFile, "SMTP_ADMIN_EMAIL")).toBe("ops@clienta.example.com");
    expect(envValue(envFile, "GOOGLE_ENABLED")).toBe("true");
    expect(envValue(envFile, "GOOGLE_CLIENT_ID")).toBe(
      "google-client-id.apps.googleusercontent.com",
    );
    expect(envValue(envFile, "GOOGLE_SECRET")).toBe("google-secret-value");
    expect(envValue(envFile, "GITHUB_ENABLED")).toBe("true");
    expect(envValue(envFile, "GITHUB_CLIENT_ID")).toBe("github-client-id");
    expect(envValue(envFile, "GITHUB_SECRET")).toBe("github-secret-value");
    expect(envValue(envFile, "AZURE_ENABLED")).toBe("true");
    expect(envValue(envFile, "AZURE_CLIENT_ID")).toBe("azure-client-id");
    expect(envValue(envFile, "AZURE_SECRET")).toBe("azure-secret-value");
  });

  it("uncomments the OAuth env lines on the auth service so GoTrue always reads them", async () => {
    const { composeYaml } = await renderDoc();
    expect(composeYaml).toContain("GOTRUE_EXTERNAL_GOOGLE_ENABLED: ${GOOGLE_ENABLED}");
    expect(composeYaml).toContain("GOTRUE_EXTERNAL_GITHUB_ENABLED: ${GITHUB_ENABLED}");
    expect(composeYaml).toContain("GOTRUE_EXTERNAL_AZURE_ENABLED: ${AZURE_ENABLED}");
    expect(composeYaml).not.toContain("# GOTRUE_EXTERNAL_GOOGLE_ENABLED");
  });

  it("rejects an Auth setting containing a line break before it ever reaches the .env", async () => {
    await expect(
      renderDoc({
        authSettings: {
          disableSignup: false,
          enableEmailSignup: true,
          enableEmailAutoconfirm: true,
          enablePhoneSignup: false,
          enableAnonymousUsers: false,
          jwtExpirySeconds: 3600,
          additionalRedirectUrls: "https://evil.example.com/x\nPOSTGRES_PASSWORD=pwned",
          smtpHost: "supabase-mail",
          smtpPort: 2500,
          smtpUser: "fake_mail_user",
          smtpPass: "fake_mail_password",
          smtpSenderName: "fake_sender",
          smtpAdminEmail: "admin@example.com",
          googleEnabled: false,
          googleClientId: "",
          googleSecret: "",
          githubEnabled: false,
          githubClientId: "",
          githubSecret: "",
          azureEnabled: false,
          azureClientId: "",
          azureSecret: "",
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
