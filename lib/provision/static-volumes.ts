/**
 * Static support-file loader (bugfix, post-M4) — the missing half of the
 * `render`/`upload` phases.
 *
 * templates/supabase/docker-compose.yml bind-mounts several files and
 * directories under `./volumes/` that renderInstanceCompose() never touches:
 *
 *   - db:      volumes/db/{realtime,jwt,_supabase,roles,webhooks,logs,pooler}.sql
 *              — Postgres init-scripts required for the container to become
 *              healthy at all. Each substitutes secrets itself at container
 *              startup (e.g. jwt.sql does `\set jwt_secret `echo "$JWT_SECRET"``
 *              against the environment docker-compose already injects), so
 *              WHARF ships them byte-identical to every instance — no
 *              per-instance templating needed, confirmed zero `{{...}}`
 *              placeholders in any of them.
 *   - kong:    volumes/api/{kong.yml,kong-entrypoint.sh} — kong-entrypoint.sh
 *              env-substitutes kong.yml into its final declarative config
 *              itself at container start; same "ship verbatim" story.
 *   - storage / snippets / functions: empty directories (each holds only a
 *              .gitkeep) that `storage` and `studio` bind-mount directly.
 *
 * Without these on the remote host, `db`'s bind-mount sources are missing,
 * Postgres fails its healthcheck, and every dependent service refuses to
 * start (`dependency failed to start: container supabase-db is unhealthy`)
 * — exactly the failure this file fixes.
 *
 * Because every file here is static, they are read once from disk and
 * uploaded verbatim — there is no "render" step for this half of the upload.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Directory holding the vendored upstream template. Duplicated from
 * render.ts's identical constant rather than imported: pipeline.test.ts mocks
 * "./render" wholesale, and this module must keep reading the real files on
 * disk regardless of that mock.
 */
const TEMPLATE_DIR = path.join("templates", "supabase");

export interface StaticVolumeFile {
  /** Path relative to templates/supabase/volumes, posix separators. */
  relPath: string;
  content: Buffer;
}

async function walk(baseDir: string, subDir: string): Promise<string[]> {
  const abs = path.join(baseDir, subDir);
  const entries = await readdir(abs, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = path.posix.join(subDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(baseDir, rel)));
    } else {
      files.push(rel);
    }
  }
  return files;
}

/**
 * Every file under templates/supabase/volumes/, read verbatim. Includes the
 * `.gitkeep` placeholders for storage/snippets/functions on purpose — writing
 * them recreates those directories on the remote host via sftpWrite's
 * mkdir-ancestors behavior, with no separate "create empty directory" path
 * needed.
 */
export async function loadStaticVolumeFiles(): Promise<StaticVolumeFile[]> {
  const baseDir = path.join(process.cwd(), TEMPLATE_DIR, "volumes");
  const relPaths = await walk(baseDir, "");
  return Promise.all(
    relPaths.map(async (relPath) => ({
      relPath,
      content: await readFile(path.join(baseDir, relPath)),
    })),
  );
}
