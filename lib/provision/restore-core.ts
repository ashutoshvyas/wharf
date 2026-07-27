/**
 * Shared Postgres load/dump primitives for the two engines that overwrite an
 * instance's data in place: restore.ts (from an uploaded file, ) and
 * sync.ts (from a live source database, ).
 *
 * Everything here runs INSIDE the instance's own `db` container via
 * `docker compose exec` — that container ships the version-matched
 * pg_dump/pg_restore/psql, so nothing has to be installed on the managed
 * host. `exec()` decodes stdout/stderr as UTF-8 (lib/ssh.ts), so it is never
 * used to carry dump bytes, only the plain-text console output of those
 * tools.
 *
 * SECRETS: `pgEnv` below is a pre-built `-e PGPASSWORD=…` fragment. It is
 * passed straight through into the remote command and MUST NOT be emitted,
 * logged or interpolated into any message — every caller builds it with
 * {@link pgPasswordEnv} and keeps it out of its own log lines.
 */
import type { EmitFn } from "@/lib/bootstrap/steps";
import { exec, sftpWrite } from "@/lib/ssh";

/** The connection handle lib/ssh hands out (ssh2 Client, never imported here). */
type SshConnection = Parameters<typeof exec>[0];

/** A full DB dump/restore can take a long time; these are generous on purpose. */
export const SNAPSHOT_TIMEOUT_MS = 30 * 60_000;
export const RESTORE_TIMEOUT_MS = 60 * 60_000;

/** Cap on lines from pg_restore/psql's own console output copied into the job log. */
const MAX_EMITTED_LINES = 200;

/** Single-quote a value for safe interpolation into a remote shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `-e PGPASSWORD=…` fragment for `docker compose exec`. Kept in one place
 * so the quoting rule lives with the secret-handling note above rather than
 * being re-derived at each call site.
 */
export function pgPasswordEnv(password: string): string {
  return `-e PGPASSWORD=${shellQuote(password)}`;
}

/** Trim, drop blanks, cap, and emit captured command output as `info` lines. */
export function emitCapturedOutput(emit: EmitFn, text: string): void {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, MAX_EMITTED_LINES)) emit("info", line);
  if (lines.length > MAX_EMITTED_LINES) {
    emit("info", `… ${lines.length - MAX_EMITTED_LINES} more line(s) truncated`);
  }
}

export interface TargetContainer {
  /** `docker compose -p {project}` — the prefix every command is run under. */
  compose: string;
  /** Result of {@link pgPasswordEnv} for the TARGET instance. Never logged. */
  pgEnv: string;
  /**
   * The role every pg_dump/pg_restore/psql below connects as — resolve it with
   * {@link resolveAdminUser}, never hard-code `postgres`.
   *
   * `postgres` is NOT a superuser in supabase/postgres, and since PG15 the
   * `public` schema is owned by `pg_database_owner` with no CREATE granted to
   * anyone else. Restoring as `postgres` therefore fails on every CREATE
   * statement and leaves an empty schema behind.
   */
  user: string;
}

/**
 * Pick the role to run restore operations as: `supabase_admin` when the image
 * provides it (it is the real superuser), otherwise `postgres`.
 *
 * The probe itself connects as `postgres` over the container's unix socket,
 * which needs no password and works even when every TCP login is broken.
 */
export async function resolveAdminUser(
  conn: SshConnection,
  compose: string,
): Promise<string> {
  const res = await exec(
    conn,
    `${compose} exec -T db psql -U postgres -d postgres -At -c ` +
      shellQuote(`select 1 from pg_roles where rolname = '${ADMIN_ROLE}'`),
  );
  return res.code === 0 && res.stdout.trim() === "1" ? ADMIN_ROLE : "postgres";
}

/**
 * pg_dump the instance's CURRENT data to a file on the host, before anything
 * overwrites it. Returns the host path, which callers surface in their log and
 * audit metadata as the way back if the load turns out to be wrong.
 */
export async function takeSafetySnapshot(
  conn: SshConnection,
  target: TargetContainer,
  paths: { containerPath: string; remotePath: string },
  emit: EmitFn,
): Promise<string> {
  // `docker compose cp` refuses to create its destination directory
  // ("invalid output path: directory ... does not exist"), so this function
  // makes it — rather than relying on a caller having done it. restore.ts
  // happens to create it in its `upload` phase; sync.ts has no upload phase
  // and would otherwise fail here every time.
  const dir = paths.remotePath.slice(0, paths.remotePath.lastIndexOf("/"));
  const mkdirRes = await exec(conn, `mkdir -p ${shellQuote(dir)}`);
  if (mkdirRes.code !== 0) {
    throw new Error(
      `mkdir -p ${dir} failed (code ${mkdirRes.code}): ${mkdirRes.stderr.trim()}`,
    );
  }

  const dumpRes = await exec(
    conn,
    `${target.compose} exec -T ${target.pgEnv} db pg_dump -U ${target.user} -Fc -d postgres ` +
      `-f ${paths.containerPath}`,
    { timeoutMs: SNAPSHOT_TIMEOUT_MS },
  );
  if (dumpRes.code !== 0) {
    throw new Error(
      `pg_dump (safety snapshot) failed (code ${dumpRes.code}): ${dumpRes.stderr.trim()}`,
    );
  }
  const cpOutRes = await exec(
    conn,
    `${target.compose} cp db:${paths.containerPath} ${paths.remotePath}`,
  );
  if (cpOutRes.code !== 0) {
    throw new Error(
      `docker compose cp (safety snapshot) failed (code ${cpOutRes.code}): ` +
        cpOutRes.stderr.trim(),
    );
  }
  await exec(conn, `${target.compose} exec -T db rm -f ${paths.containerPath}`);
  emit("info", `safety snapshot of the current data saved to ${paths.remotePath}`);
  return paths.remotePath;
}

/**
 * The flags a full (schema + data) load runs with. `--clean --if-exists`
 * drops what is there first; `--no-owner --no-acl` remaps everything to the
 * connecting role, since the source's roles do not exist here.
 *
 * A data-only pass CANNOT reuse these — pg_restore rejects `--clean` together
 * with `--data-only` — so those callers pass their own `flags`.
 */
export const FULL_RESTORE_FLAGS = ["--clean", "--if-exists", "--no-owner", "--no-acl"] as const;

/**
 * The image's actual superuser. `postgres` is NOT one here — supautils rejects
 * it with `"…" is a reserved role, only superusers can modify it`, and since
 * PG15 it cannot create objects in `public` either (owned by
 * `pg_database_owner`).
 */
export const ADMIN_ROLE = "supabase_admin";

/** Printed whenever the automatic re-assert could not complete. */
const REPAIR_HINT =
  "Repair by hand on the server: cd into the instance directory and run " +
  `\`docker compose exec -T db psql -U ${ADMIN_ROLE} -d postgres ` +
  '-f /docker-entrypoint-initdb.d/init-scripts/99-roles.sql`, then restart the stack.';

/**
 * The roles whose passwords are this INSTANCE's identity, not the source's.
 *
 * `postgres` is set by the image at initdb; the rest by the template's
 * `volumes/db/roles.sql`, which runs only once at first init. Every one of
 * them authenticates with `POSTGRES_PASSWORD` from the instance's own .env —
 * see the connection strings in templates/supabase/docker-compose.yml.
 */
export const INSTANCE_SERVICE_ROLES = [
  "postgres",
  "authenticator",
  "pgbouncer",
  "supabase_auth_admin",
  "supabase_functions_admin",
  "supabase_storage_admin",
] as const;

/**
 * Put this instance's own role passwords back after loading data from another
 * environment.
 *
 * A dump taken from a different Supabase project belongs to a cluster whose
 * roles had different credentials, and a cross-environment load can leave the
 * instance's own containers unable to authenticate — the visible symptom is
 * Studio reporting `password authentication failed for user "postgres"`, but
 * PostgREST, GoTrue and storage-api all share the same mechanism, so the
 * whole stack is exposed, not just Studio.
 *
 * Rather than reason about exactly which statements in a foreign dump can
 * disturb a role, this re-asserts the invariant afterwards: the roles above
 * always end a restore holding the password in this instance's .env.
 *
 * RUN AS `supabase_admin`, NOT `postgres`. In supabase/postgres the `postgres`
 * role is not a real superuser, and the `supautils` extension marks the
 * service roles reserved:
 *
 *   ERROR: "supabase_storage_admin" is a reserved role, only superusers can
 *   modify it
 *
 * `supabase_admin` is the superuser the image actually uses (realtime connects
 * as it, `webhooks.sql` creates schemas owned by it). `roles.sql` gets away
 * with `postgres` only because the entrypoint runs it during initdb, before
 * those restrictions apply.
 *
 * NON-FATAL. By the time this runs the data is already loaded and correct, so
 * a failure here must not throw away a successful restore or push a healthy
 * instance into the terminal `error` status. It reports loudly instead, with
 * the exact command to repair it by hand.
 *
 * SECRETS: the password is never written into the SQL, the command line, or
 * an error message. The generated script reads `$POSTGRES_PASSWORD` from the
 * db container's own environment through psql's backtick interpolation — the
 * identical idiom `roles.sql` already uses — so a psql error that echoes the
 * failing statement cannot leak it either.
 */
export async function reassertInstanceRoles(
  conn: SshConnection,
  target: TargetContainer,
  paths: { remotePath: string; containerPath: string },
  emit: EmitFn,
): Promise<void> {
  const wanted = [...INSTANCE_SERVICE_ROLES, ADMIN_ROLE].map((r) => `'${r}'`).join(", ");
  const listRes = await exec(
    conn,
    `${target.compose} exec -T db psql -U postgres -d postgres -At -c ` +
      shellQuote(`select rolname from pg_roles where rolname in (${wanted})`),
  );
  if (listRes.code !== 0) {
    emit(
      "info",
      `could not list this instance's roles (code ${listRes.code}): ${listRes.stderr.trim()} — ` +
        `skipping the credential re-assert. ${REPAIR_HINT}`,
    );
    return;
  }
  const found = new Set(listRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const present = INSTANCE_SERVICE_ROLES.filter((r) => found.has(r));
  if (present.length === 0) {
    emit("info", "no WHARF-managed roles found to re-assert — skipping");
    return;
  }
  // Falling back to `postgres` is very likely to hit supautils' reserved-role
  // guard, but it is strictly better than not trying at all.
  const adminUser = found.has(ADMIN_ROLE) ? ADMIN_ROLE : "postgres";

  // Role names come from the constant above, never from user input.
  const sql =
    "\\set pgpass `echo \"$POSTGRES_PASSWORD\"`\n" +
    present.map((r) => `ALTER USER ${r} WITH PASSWORD :'pgpass';`).join("\n") +
    "\n";

  try {
    await sftpWrite(conn, paths.remotePath, sql, 0o600);
    const cpRes = await exec(
      conn,
      `${target.compose} cp ${paths.remotePath} db:${paths.containerPath}`,
    );
    if (cpRes.code !== 0) {
      emit(
        "info",
        `docker compose cp (role re-assert) failed (code ${cpRes.code}): ` +
          `${cpRes.stderr.trim()} — ${REPAIR_HINT}`,
      );
      return;
    }
    const applyRes = await exec(
      conn,
      `${target.compose} exec -T db psql -U ${adminUser} -d postgres -v ON_ERROR_STOP=1 ` +
        `-f ${paths.containerPath}`,
    );
    if (applyRes.code !== 0) {
      // Non-fatal on purpose: the data is already loaded and correct.
      emit(
        "info",
        `could not restore this instance's role passwords as '${adminUser}' ` +
          `(code ${applyRes.code}): ${applyRes.stderr.trim()} — the DATA restored fine, but ` +
          `Studio/PostgREST/Auth may not be able to log in until this is fixed. ${REPAIR_HINT}`,
      );
      return;
    }
    emit(
      "info",
      `re-asserted this instance's credentials for ${present.join(", ")} (as ${adminUser})`,
    );
  } finally {
    await exec(conn, `${target.compose} exec -T db rm -f ${paths.containerPath}`).catch(
      () => {},
    );
    await exec(conn, `rm -f ${shellQuote(paths.remotePath)}`).catch(() => {});
  }
}

/**
 * How many tables the target holds in `schemas`, for verifying a load actually
 * landed. Returns -1 when the count could not be taken (never a reason to fail
 * a restore on its own).
 */
export async function countTables(
  conn: SshConnection,
  target: TargetContainer,
  schemas: readonly string[],
  emit: EmitFn,
): Promise<number> {
  const list = schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
  const res = await exec(
    conn,
    `${target.compose} exec -T db psql -U ${target.user} -d postgres -At -c ` +
      shellQuote(`select count(*) from pg_tables where schemaname in (${list})`),
  );
  if (res.code !== 0) {
    emit("info", `could not count restored tables: ${res.stderr.trim()}`);
    return -1;
  }
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : -1;
}

export interface LoadDumpOptions {
  /** Path of the dump INSIDE the db container. */
  containerPath: string;
  /** `.sql` goes through psql; anything else through pg_restore. */
  isSql?: boolean;
  /** pg_restore flags; defaults to {@link FULL_RESTORE_FLAGS}. */
  flags?: readonly string[];
  /** Named in the "exited non-zero" warning so multi-pass loads stay legible. */
  label?: string;
  /** Mentioned in that same warning as the way back. */
  snapshotPath?: string;
}

/**
 * Load one dump file into the target database, replacing what is there.
 *
 * pg_restore/psql commonly exit non-zero even on a substantially successful
 * restore — ownership/role/extension-version mismatches between a hosted
 * Supabase project and a self-hosted instance produce warnings pg_restore
 * itself still reports as "errors" (a well-known, widely documented Postgres
 * behavior, not specific to WHARF). Since this is the COMMON case for a
 * cross-environment load, treating any non-zero exit as a hard pipeline
 * failure would make the feature look broken for most real backups. The
 * pre-load snapshot exists precisely so a genuinely bad outcome is still
 * recoverable — surface the warning clearly and let the operator judge from
 * the actual output, rather than guessing here.
 *
 * Returns the exit code (null when the channel closed without one) so a
 * caller can summarize a multi-pass load.
 */
export async function loadDumpIntoTarget(
  conn: SshConnection,
  target: TargetContainer,
  opts: LoadDumpOptions,
  emit: EmitFn,
): Promise<number | null> {
  const flags = opts.flags ?? FULL_RESTORE_FLAGS;
  const cmd = opts.isSql
    ? `psql -U ${target.user} -d postgres -f ${opts.containerPath}`
    : `pg_restore -U ${target.user} -d postgres ${flags.join(" ")} ${opts.containerPath}`;

  const res = await exec(conn, `${target.compose} exec -T ${target.pgEnv} db ${cmd}`, {
    timeoutMs: RESTORE_TIMEOUT_MS,
  });
  emitCapturedOutput(emit, `${res.stdout}\n${res.stderr}`);

  if (res.code !== 0) {
    const tool = opts.isSql ? "psql" : "pg_restore";
    const what = opts.label ? `${tool} (${opts.label})` : tool;
    emit(
      "info",
      `${what} exited with code ${res.code} — this is commonly just cross-environment ` +
        "ownership/role warnings, not a failed restore. Review the output above." +
        (opts.snapshotPath
          ? ` The pre-restore snapshot at ${opts.snapshotPath} can be used to revert if ` +
            "the data doesn't look right."
          : ""),
    );
  }
  return res.code;
}
