/**
 * Traefik template renderer — reads the checked-in artifacts under
 * templates/traefik/ at runtime (never fetched from the network), substitutes
 * the exactly-two placeholders {{PANEL_URL}} and {{LE_EMAIL}}, and pairs each
 * file with its remote destination under TRAEFIK_REMOTE_DIR.
 *
 * Substitution values come from env (PANEL_URL, LETSENCRYPT_EMAIL) — both are
 * validated here so a misconfigured panel fails the upload step with a clear
 * message instead of shipping literal `{{…}}` to a live Traefik.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { POOLER_REMOTE_DIR, TRAEFIK_REMOTE_DIR } from "./constants";
import { ensurePoolerSecrets, type PoolerSecrets } from "./pooler-secrets";

/** Relative paths, identical under templates/traefik/ and the remote dir. */
export const TRAEFIK_TEMPLATE_FILES = [
  "docker-compose.yml",
  "traefik.yml",
  "dynamic/wharf-auth.yml",
] as const;

export interface RenderedTemplate {
  /** Path relative to templates/traefik (posix separators). */
  relPath: string;
  /** Absolute destination on the managed server. */
  remotePath: string;
  content: string;
}

/** Replace {{PANEL_URL}} / {{LE_EMAIL}} everywhere they occur. */
export function substitutePlaceholders(
  template: string,
  vars: { panelUrl: string; leEmail: string },
): string {
  return template
    .replaceAll("{{PANEL_URL}}", vars.panelUrl)
    .replaceAll("{{LE_EMAIL}}", vars.leEmail);
}

/**
 * Render all three artifacts using PANEL_URL / LETSENCRYPT_EMAIL from env.
 * Throws (→ step failure, visible in the job log) when either is unset.
 * A trailing slash on PANEL_URL is trimmed so the forwardAuth address never
 * contains `//api`.
 */
export async function renderTraefikTemplates(): Promise<RenderedTemplate[]> {
  const panelUrl = process.env.PANEL_URL?.trim().replace(/\/+$/, "");
  const leEmail = process.env.LETSENCRYPT_EMAIL?.trim();
  if (!panelUrl || !leEmail) {
    throw new Error(
      "Bootstrap requires PANEL_URL and LETSENCRYPT_EMAIL in the panel " +
        "environment (see .env.example) — set both and re-run.",
    );
  }

  const baseDir = path.join(process.cwd(), "templates", "traefik");
  return Promise.all(
    TRAEFIK_TEMPLATE_FILES.map(async (relPath) => {
      const raw = await readFile(path.join(baseDir, relPath), "utf8");
      return {
        relPath,
        remotePath: `${TRAEFIK_REMOTE_DIR}/${relPath}`,
        content: substitutePlaceholders(raw, { panelUrl, leEmail }),
      };
    }),
  );
}

/** Relative path, identical under templates/pooler/ and the remote dir. */
export const POOLER_TEMPLATE_FILES = ["docker-compose.yml"] as const;

/** Replace the pooler's secret placeholders everywhere they occur. */
export function substitutePoolerPlaceholders(
  template: string,
  secrets: PoolerSecrets,
): string {
  return template
    .replaceAll("{{POOLER_DB_PASSWORD}}", secrets.poolerDbPassword)
    .replaceAll("{{SECRET_KEY_BASE}}", secrets.secretKeyBase)
    .replaceAll("{{VAULT_ENC_KEY}}", secrets.vaultEncKey)
    .replaceAll("{{API_JWT_SECRET}}", secrets.apiJwtSecret)
    .replaceAll("{{METRICS_JWT_SECRET}}", secrets.metricsJwtSecret);
}

/**
 * Render the shared pooler's compose file for `serverId`, generating (once)
 * and reusing (every later call) that server's own pooler secrets — see
 * lib/bootstrap/pooler-secrets.ts for why they must be persisted rather than
 * re-derived on every render.
 */
export async function renderPoolerTemplates(serverId: string): Promise<RenderedTemplate[]> {
  const secrets = await ensurePoolerSecrets(serverId);
  const baseDir = path.join(process.cwd(), "templates", "pooler");
  return Promise.all(
    POOLER_TEMPLATE_FILES.map(async (relPath) => {
      const raw = await readFile(path.join(baseDir, relPath), "utf8");
      return {
        relPath,
        remotePath: `${POOLER_REMOTE_DIR}/${relPath}`,
        content: substitutePoolerPlaceholders(raw, secrets),
      };
    }),
  );
}
