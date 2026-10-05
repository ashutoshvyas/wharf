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
 * Four invariants this module is responsible for, each covered by a test:
 *
 *   1. **kong is public, studio is gated.** The kong router carries no
 *      middleware — live applications call it and must not hit a login wall.
 *      The studio router carries WHARF_AUTH_MIDDLEWARE (spec §6.1).
 *   2. **db never joins the shared traefik network.** Only kong and studio do;
 *      every other service stays on the project-private default network, so
 *      Postgres is unreachable from other tenants on the box over THAT
 *      network — see invariant 4 for the one other network db does join.
 *   3. **No published host ports on routed services.** Traefik reaches
 *      containers over the shared network, so instances can never collide on
 *      host ports 8000/8443 (which the upstream template publishes).
 *   4. **db, and only db, joins the shared pooler network.** The one shared
 *      per-server Supavisor (templates/pooler/) reaches every instance's `db`
 *      there, under a project-scoped alias (`{project}-db`) so it can tell
 *      tenants apart — see lib/bootstrap/constants.ts's POOLER_NETWORK doc
 *      comment for what this narrows about invariant 2's isolation guarantee.
 *
 * Rendering is a pure function of its inputs — no timestamps, no fresh
 * randomness — so a retried provision re-renders byte-identical files.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dump, load } from "js-yaml";
import {
  POOLER_NETWORK,
  TRAEFIK_NETWORK,
  WHARF_AUTH_MIDDLEWARE,
  WHARF_STUDIO_FRAME_MIDDLEWARE,
} from "@/lib/bootstrap/constants";
import { isValidSlug, poolerDbAlias, PROJECT_RE, subdomainsFor } from "./naming";
import {
  deriveAnalyticsSecrets,
  deriveAncillarySecrets,
  MINIO_ROOT_USER,
  type InstanceSecrets,
} from "./secrets";

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
  /**
   * Analytics buckets toggle. Absent (or `enabled: false`) renders
   * ICEBERG_ENABLED=false and an empty COMPOSE_PROFILES, so MinIO/Lakekeeper
   * stay defined-but-never-started — the default for every instance.
   */
  analyticsSettings?: AnalyticsSettingsValues;
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
/**
 * SMS delivery backends the panel offers. Deliberately not GoTrue's full
 * native list (messagebird/textlocal/vonage/twilio_verify are all supported
 * upstream and would be additive here) — only what WHARF has been asked to
 * wire, so every option in the dropdown is one that has actually been built
 * and has credential fields behind it.
 *
 * Both providers use the signed send-SMS hook so WHARF can control channel
 * selection and Twilio fallback. An enabled hook bypasses
 * GOTRUE_SMS_PROVIDER entirely, which is why this is one field and not two.
 */
export const SMS_PROVIDERS = ["", "twilio", "msg91"] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];

/** WHARF delivers both providers so the instance settings control the channel. */
export function usesSmsHook(provider: SmsProvider): boolean {
  return provider === "msg91" || provider === "twilio";
}

export interface AuthSettingsValues {
  disableSignup: boolean;
  enableEmailSignup: boolean;
  enableEmailAutoconfirm: boolean;
  enablePhoneSignup: boolean;
  /** GOTRUE_SMS_AUTOCONFIRM — true confirms a phone without verifying an OTP. */
  enablePhoneAutoconfirm: boolean;
  enableAnonymousUsers: boolean;
  /** GoTrue's linkIdentity/unlinkIdentity APIs. */
  manualLinkingEnabled: boolean;
  jwtExpirySeconds: number;
  additionalRedirectUrls: string;
  /** GoTrue's default post-auth landing URL. Empty = the instance's own API origin. */
  siteUrl: string;
  /**
   * What OAuth providers redirect back to. Empty = <api origin>/auth/v1/callback.
   * Only set when a custom domain fronts this instance — it must still reach
   * THIS instance's GoTrue, not the web app.
   */
  oauthCallbackUrl: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpSenderName: string;
  smtpAdminEmail: string;
  /** "" (none), "twilio" or "msg91" (via the panel's signed send-SMS hook). */
  smsProvider: SmsProvider;
  smsOtpExp: number;
  smsOtpLength: number;
  /** A Go duration ("1m0s"), not a number — GOTRUE_SMS_MAX_FREQUENCY is time.Duration. */
  smsMaxFrequency: string;
  smsTemplate: string;
  smsTwilioAccountSid: string;
  smsTwilioAuthToken: string;
  smsTwilioMessageServiceSid: string;
  smsTwilioDeliveryChannel: "sms" | "whatsapp";
  smsTwilioWhatsappSender: string;
  smsTwilioContentSid: string;
  smsTwilioSmsFallback: boolean;
  smsMsg91AuthKey: string;
  smsMsg91TemplateId: string;
  smsMsg91SenderId: string;
  smsMsg91OtpVariable: string;
  googleEnabled: boolean;
  /** Comma-separated: the web OAuth client plus any native/One Tap client ids. */
  googleClientId: string;
  googleSecret: string;
  /** Relaxes OIDC replay protection for native SDKs that don't expose the nonce. */
  googleSkipNonceCheck: boolean;
  /** Admits a user the provider returned no email address for. */
  googleEmailOptional: boolean;
  githubEnabled: boolean;
  githubClientId: string;
  githubSecret: string;
  azureEnabled: boolean;
  azureClientId: string;
  azureSecret: string;
  /** Apple: a Services ID (comma-separated list allowed), not a plain client id. */
  appleEnabled: boolean;
  appleClientId: string;
  /** A developer-generated ES256 JWT Apple caps at 6 months, not a long-lived secret. */
  appleSecret: string;
  /** Apple relays a real address only on first consent; "Hide My Email" gives a relay one. */
  appleEmailOptional: boolean;
}

/** Default Auth settings matching the bundled .env.template when no override is set. */
export const DEFAULT_AUTH_SETTINGS: AuthSettingsValues = {
  disableSignup: false,
  enableEmailSignup: true,
  enableEmailAutoconfirm: true,
  enablePhoneSignup: false,
  // true, not false: .env.template hardcoded ENABLE_PHONE_AUTOCONFIRM=true
  // before this was configurable, and these defaults exist to reproduce the
  // previous output exactly.
  enablePhoneAutoconfirm: true,
  enableAnonymousUsers: false,
  manualLinkingEnabled: false,
  jwtExpirySeconds: 3600,
  additionalRedirectUrls: "",
  siteUrl: "",
  oauthCallbackUrl: "",
  smtpHost: "supabase-mail",
  smtpPort: 2500,
  smtpUser: "fake_mail_user",
  smtpPass: "fake_mail_password",
  smtpSenderName: "fake_sender",
  smtpAdminEmail: "admin@example.com",
  smsProvider: "",
  // GoTrue's own ApplyDefaults values. Rendered explicitly rather than left
  // empty: these land in a `uint`/`int`/`time.Duration`, and an empty string
  // is a parse error at container start, not a silent fallback.
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
};

/** Plain shape of one instance's Analytics-buckets toggle. */
export interface AnalyticsSettingsValues {
  enabled: boolean;
}

/** Off by default — MinIO/Lakekeeper are real extra containers, unlike Vector buckets. */
export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettingsValues = {
  enabled: false,
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

/**
 * Attach `network` to a service, preserving any existing per-network config.
 * An optional `alias` (map form only) is how the shared Supavisor pooler
 * tells one instance's `db` apart from every other's on the same network —
 * see poolerDbAlias() below.
 */
function joinNetwork(service: ComposeService, network: string, alias?: string): void {
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
  current[network] = alias ? { aliases: [alias] } : null;
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
  const db = doc?.services?.db;
  if (!kong || !studio || !db) {
    throw new Error(
      `${templatePath} is missing the kong, studio and/or db service — the vendored template is out of sync with render.ts (see templates/supabase/VERSIONS.md).`,
    );
  }

  // Traefik reaches these over the shared network, so the upstream host-port
  // publications (8000/8443) are removed: two instances on one server would
  // otherwise fail to start on the second `up -d`.
  delete kong.ports;
  delete studio.ports;

  kong.labels = kongLabels(input.project, apiSubdomain);
  studio.labels = studioLabels(input.project, studioSubdomain);

  // The send-SMS hook delivers both configured providers through WHARF. Strip the three keys entirely otherwise, rather
  // than rendering them empty: an instance with no hook provider then carries
  // no hook config at all, and cannot fail config validation over a setting
  // it does not use.
  const auth = input.authSettings ?? DEFAULT_AUTH_SETTINGS;
  if (auth.smsProvider === "twilio") {
    let validPanelUrl = false;
    try {
      const url = new URL(input.panelUrl ?? "");
      validPanelUrl = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    } catch { /* Report configuration errors before writing files to the server. */ }
    if (!input.instanceId || !validPanelUrl) {
      throw new Error("Twilio delivery requires an instance ID and a public HTTPS PANEL_URL without credentials, query or fragment.");
    }
  }
  if (!usesSmsHook(auth.smsProvider)) {
    const authEnv = doc?.services?.auth?.environment;
    if (authEnv && typeof authEnv === "object" && !Array.isArray(authEnv)) {
      delete (authEnv as Record<string, unknown>).GOTRUE_HOOK_SEND_SMS_ENABLED;
      delete (authEnv as Record<string, unknown>).GOTRUE_HOOK_SEND_SMS_URI;
      delete (authEnv as Record<string, unknown>).GOTRUE_HOOK_SEND_SMS_SECRETS;
    }
  }

  joinNetwork(kong, TRAEFIK_NETWORK);
  joinNetwork(studio, TRAEFIK_NETWORK);
  // The shared per-server Supavisor pooler (lib/bootstrap/steps.ts
  // `installPooler`) reaches this instance's Postgres over POOLER_NETWORK,
  // under an alias scoped to this project so it can tell tenants apart —
  // lib/provision/pipeline.ts's `pooler` phase registers this same
  // poolerDbAlias() value as the tenant's db_host.
  joinNetwork(db, POOLER_NETWORK, poolerDbAlias(input.project));

  // Belt and braces for invariants 2 and 4: nothing but kong/studio may reach
  // the Traefik network, and nothing but db may reach the pooler network.
  for (const [name, service] of Object.entries(doc.services)) {
    if (name !== "kong" && name !== "studio" && serviceNetworkNames(service).includes(TRAEFIK_NETWORK)) {
      throw new Error(
        `Service ${name} must not join the ${TRAEFIK_NETWORK} network — only kong and studio are Traefik-routed.`,
      );
    }
    if (name !== "db" && serviceNetworkNames(service).includes(POOLER_NETWORK)) {
      throw new Error(
        `Service ${name} must not join the ${POOLER_NETWORK} network — only db is pooler-routed.`,
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
    // Created by bootstrap (installPooler) and shared with the one Supavisor
    // container per server.
    [POOLER_NETWORK]: { external: true },
  };

  const body = dump(doc, { sortKeys: false, lineWidth: -1 });

  // No timestamp here on purpose: the output must be byte-stable across renders.
  const header = [
    `# Generated by WHARF (lib/provision/render.ts) — do not edit on the server.`,
    `# Instance: ${input.slug}   project: ${input.project}   path: ${input.remotePath}`,
    `# API:    https://${apiSubdomain}    -> kong:${KONG_HTTP_CONTAINER_PORT} (public, no auth middleware)`,
    `# Studio: https://${studioSubdomain} -> studio:${STUDIO_CONTAINER_PORT} (behind ${WHARF_AUTH_MIDDLEWARE})`,
    `# Pooler: registered with the server's shared Supavisor as db_host ${poolerDbAlias(input.project)}`,
    `#         (postgres.${input.project}@<server host>:5432 / :6543 — see lib/provision/pipeline.ts)`,
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

  // Self-hosted-configurable Auth settings. Falls back to exactly
  // what this template hardcoded before this feature existed, so a fresh
  // provision with nothing configured yet renders byte-identical output.
  const auth = input.authSettings ?? DEFAULT_AUTH_SETTINGS;

  // Where GoTrue POSTs its send-SMS hook. Empty unless a
  // hook-delivered provider is selected AND we know the panel's own URL —
  // without PANEL_URL there is nothing for the instance to call back to, so
  // the hook stays off rather than pointing GoTrue at a broken address.
  const smsHookUri =
    usesSmsHook(auth.smsProvider) && input.instanceId && input.panelUrl
      ? `${input.panelUrl.replace(/\/+$/, "")}/api/db-instances/${input.instanceId}/sms-hook`
      : "";
  const bool = (b: boolean) => (b ? "true" : "false");
  Object.assign(values, {
    DISABLE_SIGNUP: bool(auth.disableSignup),
    ENABLE_EMAIL_SIGNUP: bool(auth.enableEmailSignup),
    ENABLE_EMAIL_AUTOCONFIRM: bool(auth.enableEmailAutoconfirm),
    ENABLE_PHONE_SIGNUP: bool(auth.enablePhoneSignup),
    ENABLE_PHONE_AUTOCONFIRM: bool(auth.enablePhoneAutoconfirm),
    ENABLE_ANONYMOUS_USERS: bool(auth.enableAnonymousUsers),
    MANUAL_LINKING_ENABLED: bool(auth.manualLinkingEnabled),
    JWT_EXPIRY: String(auth.jwtExpirySeconds),
    ADDITIONAL_REDIRECT_URLS: auth.additionalRedirectUrls,
    // Both override the API-origin default set in `values` above. Falling back
    // rather than storing the derived value keeps an instance's URLs correct
    // if its subdomain ever changes, and keeps an unconfigured instance
    // rendering byte-identical output to before these settings existed.
    SITE_URL: auth.siteUrl || apiUrl,
    OAUTH_CALLBACK_URL: auth.oauthCallbackUrl || `${apiUrl}/auth/v1/callback`,
    SMTP_HOST: auth.smtpHost,
    SMTP_PORT: String(auth.smtpPort),
    SMTP_USER: auth.smtpUser,
    SMTP_PASS: auth.smtpPass,
    SMTP_SENDER_NAME: auth.smtpSenderName,
    SMTP_ADMIN_EMAIL: auth.smtpAdminEmail,

    // Hook-delivered providers leave SMS_PROVIDER empty on purpose:
    // GoTrue picks the hook over the provider when both are set, and an empty
    // provider is only ever resolved at send time, never at config load.
    SMS_PROVIDER: usesSmsHook(auth.smsProvider) ? "" : auth.smsProvider,
    SMS_OTP_EXP: String(auth.smsOtpExp),
    SMS_OTP_LENGTH: String(auth.smsOtpLength),
    SMS_MAX_FREQUENCY: auth.smsMaxFrequency,
    SMS_TEMPLATE: auth.smsTemplate,
    SMS_TWILIO_ACCOUNT_SID: "",
    SMS_TWILIO_AUTH_TOKEN: "",
    SMS_TWILIO_MESSAGE_SERVICE_SID: "",
    // The hook calls back into this panel, which holds the provider credentials
    // — they are never rendered into the instance's .env at all.
    // Keyed off the resolved URI, not the provider: enabling the hook with
    // nowhere to call would swallow every OTP silently.
    HOOK_SEND_SMS_ENABLED: bool(smsHookUri !== ""),
    HOOK_SEND_SMS_URI: smsHookUri,
    HOOK_SEND_SMS_SECRETS: smsHookUri ? `v1,whsec_${ancillary.smsHookSecret}` : "",
    GOOGLE_ENABLED: bool(auth.googleEnabled),
    GOOGLE_CLIENT_ID: auth.googleClientId,
    GOOGLE_SECRET: auth.googleSecret,
    GOOGLE_SKIP_NONCE_CHECK: bool(auth.googleSkipNonceCheck),
    GOOGLE_EMAIL_OPTIONAL: bool(auth.googleEmailOptional),
    GITHUB_ENABLED: bool(auth.githubEnabled),
    GITHUB_CLIENT_ID: auth.githubClientId,
    GITHUB_SECRET: auth.githubSecret,
    AZURE_ENABLED: bool(auth.azureEnabled),
    AZURE_CLIENT_ID: auth.azureClientId,
    AZURE_SECRET: auth.azureSecret,
    APPLE_ENABLED: bool(auth.appleEnabled),
    APPLE_CLIENT_ID: auth.appleClientId,
    APPLE_SECRET: auth.appleSecret,
    APPLE_EMAIL_OPTIONAL: bool(auth.appleEmailOptional),
  });

  // Per-flow email subject/template overrides. A flow with no entry
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

  // Analytics buckets (Iceberg) — opt-in per instance, off by
  // default. MinIO's root password / the Iceberg catalog's static bearer
  // token / Lakekeeper's own Postgres encryption key are all derived from
  // this instance's jwtSecret (see deriveAnalyticsSecrets's doc comment for
  // why), so nothing here needs its own stored secret.
  const analytics = input.analyticsSettings ?? DEFAULT_ANALYTICS_SETTINGS;
  const analyticsSecrets = deriveAnalyticsSecrets(input.secrets.jwtSecret);
  Object.assign(values, {
    ICEBERG_ENABLED: bool(analytics.enabled),
    ICEBERG_CATALOG_AUTH_TOKEN: analyticsSecrets.icebergCatalogToken,
    COMPOSE_PROFILES: analytics.enabled ? "analytics" : "",
    MINIO_ROOT_USER,
    MINIO_ROOT_PASSWORD: analyticsSecrets.minioRootPassword,
    LAKEKEEPER_PG_ENCRYPTION_KEY: analyticsSecrets.lakekeeperPgEncryptionKey,
  });

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
