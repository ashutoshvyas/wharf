/**
 * The model/field contract scripts/rotate-key.ts rotates (architecture.md §6).
 *
 * Split out of the script itself so it can be verified against
 * prisma/schema.prisma by rotation-targets.test.ts: this list is hand-
 * maintained, and a `*Enc` column added to the schema without a matching entry
 * here is invisible — rotation reports success while silently leaving those
 * values sealed under the OLD key. They then fail to open once the old key is
 * discarded, which is unrecoverable data loss discovered long after the fact.
 *
 * That is not hypothetical: InstanceAuthSettings (every OAuth client secret
 * plus the SMTP password) and InstanceSyncSource (the source database password
 * and service_role key) were both missed when they were introduced, and stayed
 * missing until the schema was audited against this list. Hence the test.
 */

/** Prisma client delegate names (camelCase model accessors) this script rotates. */
export type RotationModel =
  | "server"
  | "website"
  | "dbInstance"
  | "instanceAuthSettings"
  | "instanceSyncSource";

export interface RotationTarget {
  model: RotationModel;
  /** Encrypted Bytes/Bytes? fields on that model. */
  fields: string[];
}

/**
 * Every encrypted column in the schema. Keep in sync with
 * prisma/schema.prisma — rotation-targets.test.ts fails the build if this
 * drifts, so a new `*Enc` column cannot be forgotten here.
 */
export const TARGETS: RotationTarget[] = [
  {
    model: "server",
    fields: [
      "sshPasswordEnc",
      "sshPrivateKeyEnc",
      "panelUserEnc",
      "panelPassEnc",
      "poolerSecretsEnc",
    ],
  },
  { model: "website", fields: ["accessPasswordEnc"] },
  {
    model: "dbInstance",
    fields: ["pgPasswordEnc", "anonKeyEnc", "serviceRoleKeyEnc", "jwtSecretEnc"],
  },
  {
    // SMTP password + one client secret per OAuth provider.
    model: "instanceAuthSettings",
    fields: [
      "smtpPassEnc",
      "googleSecretEnc",
      "githubSecretEnc",
      "azureSecretEnc",
      "appleSecretEnc",
      // SMS provider credentials.
      "smsTwilioAuthTokenEnc",
      "smsMsg91AuthKeyEnc",
    ],
  },
  {
    // the live source's own credentials. `pgPasswordEnc` is the one
    // NON-nullable encrypted column in the schema — always present, so it is
    // always rotated rather than skipped.
    model: "instanceSyncSource",
    fields: ["pgPasswordEnc", "serviceRoleKeyEnc"],
  },
];
