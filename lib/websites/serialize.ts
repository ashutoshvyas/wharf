/**
 * Websites module — API serializer.
 *
 * Strict allowlist between the Prisma row and the wire. Secrets NEVER leave
 * this boundary: `accessPasswordEnc` (and any decrypted value) is not part of
 * the output — the only signal is the derived boolean `hasCredential`.
 * `accessUsername` is likewise withheld from list/detail responses; both
 * halves of the credential come only from the audited reveal endpoint
 * (GET /api/websites/:id/credential).
 */

/**
 * Prisma `include` matching the embedded refs below — shared by every
 * /api/websites handler so list/detail/mutation responses are shaped alike.
 */
export const WEBSITE_INCLUDE = {
  server: { select: { id: true, name: true, host: true } },
  dbInstance: { select: { id: true, name: true, slug: true, status: true } },
} as const;

interface ServerRef {
  id: string;
  name: string;
  host: string;
}

interface DbInstanceRef {
  id: string;
  name: string;
  slug: string;
  status: string;
}

/**
 * Structural input type — a Prisma `Website` row, optionally with the
 * `server` / `dbInstance` relations included. Extra fields are ignored.
 */
export interface WebsiteRecord {
  id: string;
  domain: string;
  serverId: string;
  path: string;
  dbInstanceId: string | null;
  credentialLabel: string;
  accessPasswordEnc: Uint8Array | null;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
  server?: ServerRef | null;
  dbInstance?: DbInstanceRef | null;
}

export interface SerializedWebsite {
  id: string;
  domain: string;
  serverId: string;
  path: string;
  dbInstanceId: string | null;
  credentialLabel: string;
  hasCredential: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
  server?: ServerRef;
  dbInstance?: DbInstanceRef | null;
}

export function serializeWebsite(website: WebsiteRecord): SerializedWebsite {
  const out: SerializedWebsite = {
    id: website.id,
    domain: website.domain,
    serverId: website.serverId,
    path: website.path,
    dbInstanceId: website.dbInstanceId ?? null,
    credentialLabel: website.credentialLabel,
    hasCredential:
      website.accessPasswordEnc != null && website.accessPasswordEnc.length > 0,
    notes: website.notes,
    createdAt: website.createdAt.toISOString(),
    updatedAt: website.updatedAt.toISOString(),
  };
  if (website.server != null) {
    out.server = { id: website.server.id, name: website.server.name, host: website.server.host };
  }
  // dbInstance is embedded as `null` (vs. absent) when the relation was
  // included but the website has no linked instance — lets the client
  // distinguish "not linked" from "not loaded".
  if (website.dbInstance !== undefined) {
    out.dbInstance = website.dbInstance
      ? {
          id: website.dbInstance.id,
          name: website.dbInstance.name,
          slug: website.dbInstance.slug,
          status: website.dbInstance.status,
        }
      : null;
  }
  return out;
}
