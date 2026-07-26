/**
 * Compose + .env renderer — the `render` phase of
 * docs/provisioning-contract.md §5.
 *
 * Reads the version-pinned template under templates/supabase/ (never fetched
 * at provision time — architecture.md §4.3 step 3), and emits the two files
 * the upload phase SFTPs to `remotePath`:
 *
 *   - docker-compose.yml, with per-instance Traefik labels and networks
 *   - .env, with the generated secrets and this instance's public URLs
 *
 * Three invariants this module is responsible for, each covered by a test:
 *
 *   1. **kong is public, studio is gated.** The kong router carries no
 *      middleware — live applications call it and must not hit a login wall.
 *      The studio router carries WHARF_AUTH_MIDDLEWARE (spec §6.1).
 *   2. **db never joins the shared traefik network.** Only kong and studio do;
 *      every other service stays on the project-private default network, so
 *      Postgres is unreachable from other tenants on the box.
 *   3. **No published host ports on routed services.** Traefik reaches
 *      containers over the shared network, so instances can never collide on
 *      host ports 8000/8443 (which the upstream template publishes).
 *
 * Rendering is a pure function of its inputs — no timestamps, no fresh
 * randomness — so a retried provision re-renders byte-identical files.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dump, load } from "js-yaml";
import {
  TRAEFIK_NETWORK,
  WHARF_AUTH_MIDDLEWARE,
  WHARF_STUDIO_FRAME_MIDDLEWARE,
} from "@/lib/bootstrap/constants";
import { isValidSlug, PROJECT_RE, subdomainsFor } from "./naming";
import { deriveAncillarySecrets, type InstanceSecrets } from "./secrets";

/** Directory holding the vendored upstream template. */
export const TEMPLATE_DIR = path.join("templates", "supabase");

/** Container port kong listens on for plain HTTP proxy traffic. */
export const KONG_HTTP_CONTAINER_PORT = 8000;

/** Container port Studio's Next.js server listens on. */
export const STUDIO_CONTAINER_PORT = 3000;

/** Traefik entrypoint (:443) declared in templates/traefik/traefik.yml. */
export const TRAEFIK_ENTRYPOINT = "websecure";

/** ACME resolver name declared in templates/traefik/traefik.yml. */
export const TRAEFIK_CERT_RESOLVER = "letsencrypt";

/**
 * Hostname shape for INSTANCE_DOMAIN. Deliberately strict: the domain is
 * interpolated into a Traefik ``Host(`...`)`` rule, so a value containing a
 * backtick or a comma could forge additional matchers.
 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Anything left over after substitution — a rendering bug, never shipped. */
const PLACEHOLDER_RE = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/g;

export interface RenderInstanceInput {
  /** Instance slug, e.g. `clienta`. Validated against SLUG_RE. */
  slug: string;
  /** Compose project name from composeProjectName(), e.g. `sb_4f2a`. */
  project: string;
  /** Apex domain instances hang off (panel env INSTANCE_DOMAIN). */
  domain: string;
  /** Output of generateInstanceSecrets(). */
  secrets: InstanceSecrets;
  /** Absolute remote directory, from remotePathFor(project). Recorded in a header comment. */
  remotePath: string;
  /**
   * Self-hosted-configurable Auth settings — decrypted plain
   * values, sourced from `InstanceAuthSettings` by
   * lib/provision/auth-settings.ts. Absent on a fresh provision (nothing
   * configured yet) and defaults to exactly the values this template always
   * hardcoded, so behavior is unchanged until an operator sets something.
   */
  authSettings?: AuthSettingsValues;
  /**
   * Per-flow email subject/template overrides. `instanceId` +
   * `panelUrl` are only needed to construct the MAILER_TEMPLATES_<FLOW> URL
   * (GET /api/db-instances/:id/email-template/:flow) for a flow that has a
   * custom body — omit all three and every flow renders exactly today's
   * "unconfigured" defaults (empty subject, no template URL).
   */
  emailTemplates?: EmailTemplateValues[];
  /** DB id of the instance being rendered — see emailTemplates above. */
  instanceId?: string;
  /** Panel's own public origin (env PANEL_URL) — see emailTemplates above. */
  panelUrl?: string;
}

/** The 6 GoTrue email flows a custom template/subject can be set for. */
export type EmailTemplateFlow =
  | "confirmation"
  | "recovery"
  | "magic_link"
  | "invite"
  | "email_change"
  | "reauthentication";

export const EMAIL_TEMPLATE_FLOWS: readonly EmailTemplateFlow[] = [
  "confirmation",
  "recovery",
  "magic_link",
  "invite",
  "email_change",
  "reauthentication",
];

export interface EmailTemplateValues {
  flow: EmailTemplateFlow;
  /** Plain string — goes into .env, so subject to the same newline restriction as any other field there. */
  subject: string;
  /** Whether a custom body is stored for this flow (the URL is only set when true). */
  hasBody: boolean;
}

/** Plain (decrypted) shape of one instance's admin-configurable Auth settings. */
export interface AuthSettingsValues {
  disableSignup: boolean;
  enableEmailSignup: boolean;
  enableEmailAutoconfirm: boolean;
  enablePhoneSignup: boolean;
  enableAnonymousUsers: boolean;
  jwtExpirySeconds: number;
  additionalRedirectUrls: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpSenderName: string;
  smtpAdminEmail: string;
  googleEnabled: boolean;
  googleClientId: string;
  googleSecret: string;
  githubEnabled: boolean;
  githubClientId: string;
  githubSecret: string;
  azureEnabled: boolean;
  azureClientId: string;
  azureSecret: string;
}

/** Exactly what .env.template hardcoded before unchanged behavior when unset. */
export const DEFAULT_AUTH_SETTINGS: AuthSettingsValues = {
  disableSignup: false,
  enableEmailSignup: true,
  enableEmailAutoconfirm: true,
  enablePhoneSignup: false,
  enableAnonymousUsers: false,
  jwtExpirySeconds: 3600,
  additionalRedirectUrls: "",
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
};

export interface RenderedInstance {
  composeYaml: string;
  envFile: string;
}

/** Minimal structural view of the parts of the compose file we mutate. */
interface ComposeService {
  ports?: unknown[];
  labels?: string[];
  networks?: string[] | Record<string, unknown>;
  [key: string]: unknown;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Network names a service is attached to, normalising compose's two accepted
 * forms (`networks: [a, b]` and `networks: {a: {...}, b: null}`).
 * Absent means "the implicit default network only".
 */
export function serviceNetworkNames(service: ComposeService | undefined): string[] {
  if (!service?.networks) return [];
  return Array.isArray(service.networks)
    ? [...service.networks]
    : Object.keys(service.networks);
}

/** Traefik labels for the public API router on kong. No middleware, by design. */
export function kongLabels(project: string, apiSubdomain: string): string[] {
  const router = `${project}-api`;
  return [
    "traefik.enable=true",
    `traefik.http.routers.${router}.rule=Host(\`${apiSubdomain}\`)`,
    `traefik.http.routers.${router}.entrypoints=${TRAEFIK_ENTRYPOINT}`,
    `traefik.http.routers.${router}.tls.certresolver=${TRAEFIK_CERT_RESOLVER}`,
    `traefik.http.services.${router}.loadbalancer.server.port=${KONG_HTTP_CONTAINER_PORT}`,
  ];
}

/**
 * Traefik labels for the Studio router — identical to kong's plus the auth
 * middleware and the frame-allow middleware (the panel embeds Studio in an
 * iframe, manage-view.tsx; Studio's own default frame-blocking headers would
 * otherwise block that — see WHARF_STUDIO_FRAME_MIDDLEWARE).
 */
export function studioLabels(project: string, studioSubdomain: string): string[] {
  const router = `${project}-studio`;
  return [
    "traefik.enable=true",
    `traefik.http.routers.${router}.rule=Host(\`${studioSubdomain}\`)`,
    `traefik.http.routers.${router}.entrypoints=${TRAEFIK_ENTRYPOINT}`,
    `traefik.http.routers.${router}.tls.certresolver=${TRAEFIK_CERT_RESOLVER}`,
    `traefik.http.routers.${router}.middlewares=${WHARF_AUTH_MIDDLEWARE},${WHARF_STUDIO_FRAME_MIDDLEWARE}`,
    `traefik.http.services.${router}.loadbalancer.server.port=${STUDIO_CONTAINER_PORT}`,
  ];
}

/**
 * Reject anything that could break out of the YAML/dotenv/Traefik-rule
 * contexts we interpolate into. Runs *before* any templating, so a hostile
 * slug never reaches a template string.
 */
function validateInput(input: RenderInstanceInput): void {
  if (!isValidSlug(input.slug)) {
    throw new Error(
      `Invalid slug ${JSON.stringify(input.slug)} — must match ^[a-z0-9][a-z0-9-]*$ and be at most 40 characters.`,
    );
  }
  if (!PROJECT_RE.test(input.project)) {
    throw new Error(
      `Invalid compose project name ${JSON.stringify(input.project)} — expected sb_ followed by 4 hex characters.`,
    );
  }
  if (!input.domain || !DOMAIN_RE.test(input.domain)) {
    throw new Error(
      `Invalid instance domain ${JSON.stringify(input.domain)} — set INSTANCE_DOMAIN to a bare hostname such as wharf.example.com.`,
    );
  }
  if (!input.remotePath.startsWith("/")) {
    throw new Error(`Invalid remotePath ${JSON.stringify(input.remotePath)} — must be absolute.`);
  }
  for (const [name, value] of Object.entries(input.secrets)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Missing secret ${name} — generateInstanceSecrets() must run first.`);
    }
    // A newline would terminate the .env line early and smuggle in a variable.
    if (/[\r\n]/.test(value)) {
      throw new Error(`Secret ${name} contains a line break, which cannot be written to a .env.`);
    }
  }
  // Same injection risk applies to admin-supplied Auth settings strings
  // — these ultimately reach the same unescaped .env format.
  if (input.authSettings) {
    for (const [name, value] of Object.entries(input.authSettings)) {
      if (typeof value === "string" && /[\r\n]/.test(value)) {
        throw new Error(
          `Auth setting ${name} contains a line break, which cannot be written to a .env.`,
        );
      }
    }
  }
  // Email template subjects go into .env too — same restriction.
  // bodyHtml is deliberately NOT checked here: it never touches .env (it's
  // served over its own HTTP route) and must allow multi-line content.
  if (input.emailTemplates) {
    for (const entry of input.emailTemplates) {
      if (/[\r\n]/.test(entry.subject)) {
        throw new Error(
          `Email template subject for '${entry.flow}' contains a line break, which cannot be written to a .env.`,
        );
      }
    }
  }
}

/** Attach `network` to a service, preserving any existing per-network config. */
function joinNetwork(service: ComposeService, network: string): void {
  if (Array.isArray(service.networks)) {
    const existing = new Set(service.networks);
    existing.add(network);
    service.networks = [...existing];
    return;
  }
  const current = (service.networks ?? {}) as Record<string, unknown>;
  // `default` must stay explicit once the map form is used, otherwise compose
  // reads the service as being on `traefik` only.
  if (!("default" in current)) current.default = null;
  current[network] = null;
  service.networks = current;
}

/** Render the instance's docker-compose.yml from the vendored template. */
async function renderCompose(
  input: RenderInstanceInput,
  apiSubdomain: string,
  studioSubdomain: string,
): Promise<string> {
  const templatePath = path.join(process.cwd(), TEMPLATE_DIR, "docker-compose.yml");
  const doc = load(await readFile(templatePath, "utf8")) as ComposeFile;

  const kong = doc?.services?.kong;
  const studio = doc?.services?.studio;
  if (!kong || !studio) {
    throw new Error(
      `${templatePath} is missing the kong and/or studio service — the vendored template is out of sync with render.ts (see templates/supabase/VERSIONS.md).`,
    );
  }

  // Traefik reaches these over the shared network, so the upstream host-port
  // publications (8000/8443) are removed: two instances on one server would
  // otherwise fail to start on the second `up -d`.
  delete kong.ports;
  delete studio.ports;

  kong.labels = kongLabels(input.project, apiSubdomain);
  studio.labels = studioLabels(input.project, studioSubdomain);

  joinNetwork(kong, TRAEFIK_NETWORK);
  joinNetwork(studio, TRAEFIK_NETWORK);

  // Belt and braces for invariant 2: nothing but the two routed services may
  // be reachable from the shared network.
  for (const [name, service] of Object.entries(doc.services)) {
    if (name === "kong" || name === "studio") continue;
    if (serviceNetworkNames(service).includes(TRAEFIK_NETWORK)) {
      throw new Error(
        `Service ${name} must not join the ${TRAEFIK_NETWORK} network — only kong and studio are Traefik-routed.`,
      );
    }
  }

  doc.networks = {
    // Project-private network every service shares. Named explicitly so the
    // rendered file documents it rather than relying on compose's implicit
    // `<project>_default`.
    default: { name: `${input.project}_default` },
    // Created by bootstrap and shared with the Traefik container.
    [TRAEFIK_NETWORK]: { external: true },
  };

  const body = dump(doc, { sortKeys: false, lineWidth: -1 });

  // No timestamp here on purpose: the output must be byte-stable across renders.
  const header = [
    `# Generated by WHARF (lib/provision/render.ts) — do not edit on the server.`,
    `# Instance: ${input.slug}   project: ${input.project}   path: ${input.remotePath}`,
    `# API:    https://${apiSubdomain}    -> kong:${KONG_HTTP_CONTAINER_PORT} (public, no auth middleware)`,
    `# Studio: https://${studioSubdomain} -> studio:${STUDIO_CONTAINER_PORT} (behind ${WHARF_AUTH_MIDDLEWARE})`,
    `# Re-running provisioning overwrites this file. Source template:`,
    `# ${TEMPLATE_DIR}/docker-compose.yml (see VERSIONS.md for the upstream ref).`,
    "",
  ].join("\n");

  return header + body;
}

/** Render the instance's .env from templates/supabase/.env.template. */
async function renderEnv(
  input: RenderInstanceInput,
  apiSubdomain: string,
): Promise<string> {
  const templatePath = path.join(process.cwd(), TEMPLATE_DIR, ".env.template");
  const template = await readFile(templatePath, "utf8");
  const ancillary = deriveAncillarySecrets(input.secrets.jwtSecret);
  const apiUrl = `https://${apiSubdomain}`;

  const values: Record<string, string> = {
    POSTGRES_PASSWORD: input.secrets.pgPassword,
    JWT_SECRET: input.secrets.jwtSecret,
    ANON_KEY: input.secrets.anonKey,
    SERVICE_ROLE_KEY: input.secrets.serviceRoleKey,

    SITE_URL: apiUrl,
    // Origin only, no /auth/v1 suffix: GoTrue appends MAILER_URLPATHS_*
    // (which already start with /auth/v1) to this, and kong routes that prefix
    // to the auth container. Upstream's .env.example includes the suffix,
    // which double-prefixes mail links — see VERSIONS.md "Deliberate divergences".
    API_EXTERNAL_URL: apiUrl,
    SUPABASE_PUBLIC_URL: apiUrl,

    STUDIO_DEFAULT_ORGANIZATION: "WHARF",
    STUDIO_DEFAULT_PROJECT: input.slug,

    DASHBOARD_USERNAME: "wharf",
    DASHBOARD_PASSWORD: ancillary.dashboardPassword,
    SECRET_KEY_BASE: ancillary.secretKeyBase,
    REALTIME_DB_ENC_KEY: ancillary.realtimeDbEncKey,
    PG_META_CRYPTO_KEY: ancillary.pgMetaCryptoKey,
    S3_PROTOCOL_ACCESS_KEY_ID: ancillary.s3AccessKeyId,
    S3_PROTOCOL_ACCESS_KEY_SECRET: ancillary.s3AccessKeySecret,
  };

  // self-hosted-configurable Auth settings. Falls back to exactly
  // what this template hardcoded before this feature existed, so a fresh
  // provision with nothing configured yet renders byte-identical output.
  const auth = input.authSettings ?? DEFAULT_AUTH_SETTINGS;
  const bool = (b: boolean) => (b ? "true" : "false");
  Object.assign(values, {
    DISABLE_SIGNUP: bool(auth.disableSignup),
    ENABLE_EMAIL_SIGNUP: bool(auth.enableEmailSignup),
    ENABLE_EMAIL_AUTOCONFIRM: bool(auth.enableEmailAutoconfirm),
    ENABLE_PHONE_SIGNUP: bool(auth.enablePhoneSignup),
    ENABLE_ANONYMOUS_USERS: bool(auth.enableAnonymousUsers),
    JWT_EXPIRY: String(auth.jwtExpirySeconds),
    ADDITIONAL_REDIRECT_URLS: auth.additionalRedirectUrls,
    SMTP_HOST: auth.smtpHost,
    SMTP_PORT: String(auth.smtpPort),
    SMTP_USER: auth.smtpUser,
    SMTP_PASS: auth.smtpPass,
    SMTP_SENDER_NAME: auth.smtpSenderName,
    SMTP_ADMIN_EMAIL: auth.smtpAdminEmail,
    GOOGLE_ENABLED: bool(auth.googleEnabled),
    GOOGLE_CLIENT_ID: auth.googleClientId,
    GOOGLE_SECRET: auth.googleSecret,
    GITHUB_ENABLED: bool(auth.githubEnabled),
    GITHUB_CLIENT_ID: auth.githubClientId,
    GITHUB_SECRET: auth.githubSecret,
    AZURE_ENABLED: bool(auth.azureEnabled),
    AZURE_CLIENT_ID: auth.azureClientId,
    AZURE_SECRET: auth.azureSecret,
  });

  // per-flow email subject/template overrides. A flow with no entry
  // (or no instanceId/panelUrl to build the URL from) renders both vars
  // empty — GoTrue treats empty exactly like unset, falling back to its own
  // built-in default (confirmed; see the module doc for this feature).
  const templatesByFlow = new Map((input.emailTemplates ?? []).map((e) => [e.flow, e]));
  const panelOrigin = input.panelUrl?.replace(/\/+$/, "");
  for (const flow of EMAIL_TEMPLATE_FLOWS) {
    const entry = templatesByFlow.get(flow);
    const suffix = flow.toUpperCase();
    values[`MAILER_SUBJECTS_${suffix}`] = entry?.subject ?? "";
    values[`MAILER_TEMPLATES_${suffix}`] =
      entry?.hasBody && input.instanceId && panelOrigin
        ? `${panelOrigin}/api/db-instances/${input.instanceId}/email-template/${flow}`
        : "";
  }

  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }

  // A surviving {{...}} means the template gained a variable render.ts does not
  // know about. Shipping it would start containers with a literal placeholder
  // as a password, so fail the render phase loudly instead.
  const leftovers = [...new Set(rendered.match(PLACEHOLDER_RE) ?? [])];
  if (leftovers.length > 0) {
    throw new Error(
      `${templatePath} has unsubstituted placeholders: ${leftovers.join(", ")}. ` +
        `Add them to renderInstanceCompose's value map.`,
    );
  }

  return rendered;
}

/**
 * Render both artifacts for one instance.
 *
 * Throws — failing the `render` phase — on an invalid slug, project name,
 * domain or remote path, on a template missing kong/studio, and on any
 * placeholder the value map does not cover.
 */
export async function renderInstanceCompose(
  input: RenderInstanceInput,
): Promise<RenderedInstance> {
  validateInput(input);
  const { apiSubdomain, studioSubdomain } = subdomainsFor(input.slug, input.domain);
  const [composeYaml, envFile] = await Promise.all([
    renderCompose(input, apiSubdomain, studioSubdomain),
    renderEnv(input, apiSubdomain),
  ]);
  return { composeYaml, envFile };
}
