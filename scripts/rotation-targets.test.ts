/**
 * Guards the hand-maintained rotation contract against the real schema.
 *
 * A `*Enc` column that exists in prisma/schema.prisma but not in TARGETS is
 * silently skipped by scripts/rotate-key.ts — the rotation reports success
 * while leaving those values sealed under the OLD key, and they become
 * unrecoverable the moment that key is discarded. This test is the reason a
 * new encrypted column cannot be forgotten.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TARGETS } from "./rotation-targets";

/** Every `<name>Enc Bytes[?]` field in the schema, grouped by delegate name. */
function encryptedColumnsFromSchema(): Map<string, string[]> {
  const schema = readFileSync(
    path.join(process.cwd(), "prisma", "schema.prisma"),
    "utf8",
  );
  const byModel = new Map<string, string[]>();
  let currentModel: string | null = null;

  for (const rawLine of schema.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;

    const modelStart = /^model\s+(\w+)\s*\{/.exec(line);
    if (modelStart) {
      // Prisma delegates are the model name with a lowercased first letter.
      currentModel = modelStart[1]![0]!.toLowerCase() + modelStart[1]!.slice(1);
      continue;
    }
    if (line === "}") {
      currentModel = null;
      continue;
    }
    if (!currentModel) continue;

    const field = /^(\w+Enc)\s+Bytes\??\s*(?:@|$)/.exec(line);
    if (field) {
      const fields = byModel.get(currentModel) ?? [];
      fields.push(field[1]!);
      byModel.set(currentModel, fields);
    }
  }
  return byModel;
}

describe("rotation TARGETS vs prisma/schema.prisma", () => {
  const fromSchema = encryptedColumnsFromSchema();
  const fromTargets = new Map(TARGETS.map((t) => [t.model as string, t.fields]));

  it("finds encrypted columns in the schema at all (guards the parser itself)", () => {
    // If the parser silently stopped matching, every other assertion here
    // would pass vacuously.
    expect(fromSchema.size).toBeGreaterThanOrEqual(5);
    expect(fromSchema.get("server")).toContain("sshPasswordEnc");
  });

  it("covers every model that has an encrypted column", () => {
    const missing = [...fromSchema.keys()].filter((m) => !fromTargets.has(m));
    expect(missing, `models with *Enc columns missing from TARGETS: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("covers every encrypted column on each of those models", () => {
    for (const [model, schemaFields] of fromSchema) {
      const targetFields = fromTargets.get(model) ?? [];
      const missing = schemaFields.filter((f) => !targetFields.includes(f));
      expect(missing, `${model}: *Enc columns missing from TARGETS: ${missing.join(", ")}`)
        .toEqual([]);
    }
  });

  it("lists no field that no longer exists in the schema", () => {
    for (const [model, targetFields] of fromTargets) {
      const schemaFields = fromSchema.get(model) ?? [];
      const stale = targetFields.filter((f) => !schemaFields.includes(f));
      expect(stale, `${model}: TARGETS lists fields not in the schema: ${stale.join(", ")}`)
        .toEqual([]);
    }
  });

  it("names each model at most once", () => {
    const names = TARGETS.map((t) => t.model);
    expect(names).toHaveLength(new Set(names).size);
  });

  // The two that were actually missed in the field — named explicitly so a
  // regression is reported as itself rather than as a generic diff.
  it("includes the OAuth/SMTP secrets and the sync source's credentials", () => {
    expect(fromTargets.get("instanceAuthSettings")).toEqual(
      expect.arrayContaining([
        "smtpPassEnc",
        "googleSecretEnc",
        "githubSecretEnc",
        "azureSecretEnc",
        "appleSecretEnc",
      ]),
    );
    expect(fromTargets.get("instanceSyncSource")).toEqual(
      expect.arrayContaining(["pgPasswordEnc", "serviceRoleKeyEnc"]),
    );
  });
});
