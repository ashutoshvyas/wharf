/**
 * Orphan detection — compose projects present on a server that WHARF
 * has no row for.
 *
 * Deliberately separate from recovery.ts: this module imports lib/ssh (and so
 * ssh2's native addons), while the stale-job sweep must stay importable from
 * the instrumentation hook, which Next also compiles for the edge runtime.
 * See lib/provision/job-ids.ts for the same reasoning.
 *
 * READ-ONLY: resolution is manual (architecture §4.3).
 */
import { prisma } from "@/lib/db";
import { exec, withConnection } from "@/lib/ssh";

/** Compose projects WHARF creates are the only ones it reports on. */
const MANAGED_PROJECT_PREFIX = "sb_";

export interface OrphanProject {
  project: string;
  path?: string;
}

/**
 * Shape of one entry of `docker compose ls --format json`. Docker has shipped
 * both `{Name, Status, ConfigFiles}` and lowercase variants across versions,
 * and wraps the array in different envelopes — {@link parseComposeLs} accepts
 * all of them and skips anything unrecognizable rather than throwing.
 */
function parseComposeLs(stdout: string): OrphanProject[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Some builds emit newline-delimited JSON objects instead of an array.
    const rows: OrphanProject[] = [];
    for (const line of trimmed.split("\n")) {
      const text = line.trim();
      if (!text.startsWith("{")) continue;
      try {
        const entry = toProject(JSON.parse(text));
        if (entry) rows.push(entry);
      } catch {
        /* skip unparsable line */
      }
    }
    return rows;
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { Projects?: unknown })?.Projects)
      ? (parsed as { Projects: unknown[] }).Projects
      : [];

  const out: OrphanProject[] = [];
  for (const raw of list) {
    const entry = toProject(raw);
    if (entry) out.push(entry);
  }
  return out;
}

function toProject(raw: unknown): OrphanProject | null {
  if (raw === null || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const name = rec.Name ?? rec.name;
  if (typeof name !== "string" || name === "") return null;

  const configFiles = rec.ConfigFiles ?? rec.configFiles ?? rec.config_files;
  const path =
    typeof configFiles === "string" && configFiles !== ""
      ? configFiles.split(",")[0]
      : undefined;

  return path ? { project: name, path } : { project: name };
}

/**
 * Compose projects running on `serverId` that WHARF has no row for.
 *
 * Only `sb_`-prefixed projects are reported — anything else on the box was
 * put there by the operator and is none of the panel's business. Soft-deleted
 * rows count as "known" so an instance awaiting its hard purge (its files may
 * legitimately still be on disk) is not flagged as an orphan.
 *
 * READ-ONLY: resolution is manual (architecture §4.3).
 */
export async function findOrphans(serverId: string): Promise<OrphanProject[]> {
  // Soft-deleted rows included on purpose — see doc comment.
  const rows = await prisma.dbInstance.findMany({
    where: { serverId },
    select: { composeProjectName: true },
  });
  const known = new Set(rows.map((r) => r.composeProjectName));

  const stdout = await withConnection(serverId, async (conn) => {
    const result = await exec(conn, "docker compose ls --format json", {
      timeoutMs: 20_000,
    });
    // A non-zero exit (no docker, old CLI without `compose ls`) means we
    // simply cannot tell — report nothing rather than inventing orphans.
    if (result.code !== 0) return "";
    return result.stdout;
  });

  return parseComposeLs(stdout).filter(
    (p) => p.project.startsWith(MANAGED_PROJECT_PREFIX) && !known.has(p.project),
  );
}
