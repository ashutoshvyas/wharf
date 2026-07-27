/**
 * CI guard: fail the build if code logs secret material.
 *
 * The panel decrypts SSH credentials, Supabase keys and Postgres passwords in
 * memory on nearly every provisioning path. A single stray console.log of one
 * of those values would write plaintext credentials into journald, where they
 * would persist far longer than the request that produced them. Code review
 * catches this unreliably; a grep does not.
 *
 * Run: npx tsx scripts/check-secret-logging.ts   (wired into CI)
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/** Identifiers that hold plaintext secrets somewhere in the codebase. */
const SECRET_TOKENS = [
  "WHARF_MASTER_KEY",
  "masterKey",
  "pgPassword",
  "jwtSecret",
  "anonKey",
  "serviceRoleKey",
  "sshPassword",
  "sshPrivateKey",
  "privateKey",
  "panelPass",
  "accessPassword",
  "passwordHash",
  "plaintext",
  // the live-sync source's own credentials.
  "sourcePassword",
  "sourceServiceRoleKey",
  "srcToken",
  "dstToken",
];

const LOG_CALL = /\b(?:console\.(?:log|info|warn|error|debug|trace)|logger\.(?:info|warn|error|debug|trace|fatal))\s*\(/;

const SCAN_GLOBS = ["lib", "app", "gateway/src", "scripts", "prisma"];

function sourceFiles(): string[] {
  const out = execSync(
    `find ${SCAN_GLOBS.join(" ")} -type f \\( -name '*.ts' -o -name '*.tsx' \\) ` +
      `-not -name '*.test.ts' -not -name '*.test.tsx' 2>/dev/null || true`,
    { encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
}

interface Finding {
  file: string;
  line: number;
  text: string;
  token: string;
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of sourceFiles()) {
    // The guard itself names every token; skip it.
    if (file.endsWith("check-secret-logging.ts")) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!LOG_CALL.test(line)) return;
      // An allowlist comment documents a reviewed exception.
      if (line.includes("secret-log-ok")) return;
      for (const token of SECRET_TOKENS) {
        // Match the identifier as a whole word inside the log call.
        if (new RegExp(`\\b${token}\\b`).test(line)) {
          findings.push({ file, line: i + 1, text: line.trim(), token });
          break;
        }
      }
    });
  }
  return findings;
}

const findings = scan();
if (findings.length > 0) {
  console.error(
    `✗ ${findings.length} log statement(s) reference secret material:\n` +
      findings
        .map((f) => `  ${f.file}:${f.line}  [${f.token}]\n      ${f.text}`)
        .join("\n") +
      "\n\nRemove the value from the log, or append a `// secret-log-ok` " +
      "comment on the line if it is provably not the plaintext.",
  );
  process.exit(1);
}
console.log("✓ no log statement references secret material");
