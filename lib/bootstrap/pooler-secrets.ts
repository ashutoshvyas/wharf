/**
 * Shared per-server Supavisor pooler secrets — generated once per
 * server on the first `installPooler` bootstrap step (lib/bootstrap/steps.ts)
 * and reused on every later bootstrap re-run.
 *
 * These must be persisted, not re-derived: VAULT_ENC_KEY encrypts every
 * tenant's db_password inside Supavisor's own metadata store, so rotating it
 * out from under already-registered tenants would corrupt their stored
 * credentials. Sealed the same way DbInstance's secrets are
 * (lib/crypto seal/open, AES-256-GCM) into Server.poolerSecretsEnc as one
 * JSON blob — a single column rather than four, since these values are only
 * ever read/written together, never individually revealed in the UI the way
 * an instance's own secrets are.
 */
import { open } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { sealBytes } from "@/lib/servers/seal-bytes";
import { generateAlphanumeric, generateJwtSecret, generatePgPassword } from "@/lib/provision/secrets";

export interface PoolerSecrets {
  /** Password for the pooler-db `supavisor_admin` role (metadata store only). */
  poolerDbPassword: string;
  /** Phoenix requires >= 64 characters. */
  secretKeyBase: string;
  /** Supavisor requires exactly 32 characters — encrypts tenant db_passwords at rest. */
  vaultEncKey: string;
  /** HS256 secret verifying Bearer JWTs on the admin API (tenant register/deregister). */
  apiJwtSecret: string;
  /** Separate secret for Supavisor's own /metrics endpoint. */
  metricsJwtSecret: string;
}

function generate(): PoolerSecrets {
  return {
    poolerDbPassword: generatePgPassword(),
    secretKeyBase: generateAlphanumeric(64),
    vaultEncKey: generateAlphanumeric(32),
    apiJwtSecret: generateJwtSecret(),
    metricsJwtSecret: generateJwtSecret(),
  };
}

/**
 * Load `serverId`'s pooler secrets, generating and persisting them on first
 * call. Safe to call on every `installPooler` apply — a re-run always sees
 * the same values once they exist.
 */
export async function ensurePoolerSecrets(serverId: string): Promise<PoolerSecrets> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { poolerSecretsEnc: true },
  });
  if (!server) throw new Error(`Server ${serverId} not found`);

  if (server.poolerSecretsEnc) {
    return JSON.parse(open(server.poolerSecretsEnc)) as PoolerSecrets;
  }

  const secrets = generate();
  await prisma.server.update({
    where: { id: serverId },
    data: { poolerSecretsEnc: sealBytes(JSON.stringify(secrets)) },
  });
  return secrets;
}
