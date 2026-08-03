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

/** Roles PostgREST/Studio/an app connect through — every restored schema must stay usable by all four. */
export const DATA_ACCESS_ROLES = ["postgres", "anon", "authenticated", "service_role"] as const;

/** A SQL string literal, single-quote-escaped — for embedding a schema name as a `format()` argument. */
export function sqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** A SQL (possibly-)quoted identifier — for embedding a schema name where Postgres expects a name, not a string. */
export function sqlIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * The `schema.table` names present in `schemas`, or null when the list could
 * not be taken (never a reason to fail a restore on its own).
 *
 * Used to prove a load actually created what it was supposed to: sync.ts
 * takes this from the SOURCE and the TARGET and diffs them, which is the only
 * way to catch objects a tolerated non-zero exit quietly dropped.
 */
export async function listTables(
  conn: SshConnection,
  target: TargetContainer,
  schemas: readonly string[],
  emit: EmitFn,
): Promise<string[] | null> {
  const list = schemas.map(sqlLiteral).join(", ");
  const res = await exec(
    conn,
    `${target.compose} exec -T db psql -U ${target.user} -d postgres -At -c ` +
      shellQuote(TABLE_LIST_SQL(list)),
  );
  if (res.code !== 0) {
    emit("info", `could not list restored tables: ${res.stderr.trim()}`);
    return null;
  }
  return parseTableList(res.stdout);
}

/** One `schema.table` per line, ordered so two listings are directly comparable. */
export function TABLE_LIST_SQL(schemaList: string): string {
  return (
    `select schemaname || '.' || tablename from pg_tables ` +
    `where schemaname in (${schemaList}) order by 1`
  );
}

/** Split the output of {@link TABLE_LIST_SQL} into names. */
export function parseTableList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Put every object now in `schemas` back under this instance's normal
 * ownership and grants, after a full-schema load (restore/sync) replaced them.
 *
 * WHY THIS IS NEEDED: loadDumpIntoTarget necessarily connects as whichever
 * role can DROP whatever was there before — `target.user`, resolved by
 * {@link resolveAdminUser} to `supabase_admin` (the image's real superuser)
 * whenever it exists. With `--no-owner`, pg_restore/psql then makes THAT
 * connecting role the owner of every (re)created object — not `postgres`,
 * the role a normal, never-restored instance actually owns its tables as
 * (Studio's postgres-meta connects as `postgres`; see PG_META_DB_USER in
 * templates/supabase/docker-compose.yml). The image's own default-privilege
 * grants for `public` are scoped `FOR ROLE postgres` and only fire for
 * objects a FUTURE `postgres`-run CREATE makes — they never apply
 * retroactively, and never apply at all to something supabase_admin created.
 * Left alone, PostgREST/Studio/GoTrue see a schema they hold no privileges
 * on: every read and write fails, which looks exactly like "nothing was
 * restored" even though the data landed correctly (the field report this
 * fixes: source owner `supabase_admin`, instance's own owner `postgres`).
 *
 * NON-FATAL, same as reassertInstanceRoles: by the time this runs the data is
 * already loaded and correct, so a failure here must not throw away a
 * successful restore — it reports loudly instead.
 */
export async function reassertSchemaPrivileges(
  conn: SshConnection,
  target: TargetContainer,
  schemas: readonly string[],
  paths: { remotePath: string; containerPath: string },
  emit: EmitFn,
): Promise<void> {
  if (schemas.length === 0) return;
  const roles = DATA_ACCESS_ROLES.join(", ");
  const statements: string[] = [];
  for (const schema of schemas) {
    const lit = sqlLiteral(schema);
    const ident = sqlIdent(schema);
    // ALTER ROUTINE (not ALTER FUNCTION) is the one form Postgres documents as
    // working uniformly across plain functions, procedures AND aggregates, so
    // this doesn't need to filter pg_proc by kind first.
    statements.push(
      `DO $$ DECLARE r record; BEGIN ` +
        `FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = ${lit} LOOP ` +
        `EXECUTE format('ALTER TABLE %I.%I OWNER TO postgres', ${lit}, r.tablename); END LOOP; ` +
        `FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = ${lit} LOOP ` +
        `EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO postgres', ${lit}, r.sequencename); END LOOP; ` +
        `FOR r IN SELECT viewname FROM pg_views WHERE schemaname = ${lit} LOOP ` +
        `EXECUTE format('ALTER VIEW %I.%I OWNER TO postgres', ${lit}, r.viewname); END LOOP; ` +
        `FOR r IN SELECT matviewname FROM pg_matviews WHERE schemaname = ${lit} LOOP ` +
        `EXECUTE format('ALTER MATERIALIZED VIEW %I.%I OWNER TO postgres', ${lit}, r.matviewname); END LOOP; ` +
        `FOR r IN SELECT p.oid::regprocedure::text AS sig FROM pg_proc p ` +
        `JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${lit} LOOP ` +
        `EXECUTE format('ALTER ROUTINE %s OWNER TO postgres', r.sig); END LOOP; ` +
        `END $$;`,
    );
    statements.push(`GRANT USAGE ON SCHEMA ${ident} TO ${roles};`);
    statements.push(`GRANT ALL ON ALL TABLES IN SCHEMA ${ident} TO ${roles};`);
    statements.push(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${ident} TO ${roles};`);
    statements.push(`GRANT ALL ON ALL ROUTINES IN SCHEMA ${ident} TO ${roles};`);
    statements.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ${ident} GRANT ALL ON TABLES TO ${roles};`,
    );
    statements.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ${ident} GRANT ALL ON SEQUENCES TO ${roles};`,
    );
    statements.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ${ident} GRANT ALL ON ROUTINES TO ${roles};`,
    );
  }
  const sql = `${statements.join("\n")}\n`;

  try {
    await sftpWrite(conn, paths.remotePath, sql, 0o600);
    const cpRes = await exec(
      conn,
      `${target.compose} cp ${paths.remotePath} db:${paths.containerPath}`,
    );
    if (cpRes.code !== 0) {
      emit(
        "info",
        `docker compose cp (schema privilege re-assert) failed (code ${cpRes.code}): ` +
          `${cpRes.stderr.trim()} — repair by hand: re-run this restore/sync, or GRANT/ALTER ` +
          `DEFAULT PRIVILEGES on ${schemas.join(", ")} to postgres/anon/authenticated/service_role yourself.`,
      );
      return;
    }
    const applyRes = await exec(
      conn,
      `${target.compose} exec -T db psql -U ${target.user} -d postgres -v ON_ERROR_STOP=1 ` +
        `-f ${paths.containerPath}`,
    );
    if (applyRes.code !== 0) {
      emit(
        "info",
        `could not re-assert ownership/privileges on ${schemas.join(", ")} ` +
          `(code ${applyRes.code}): ${applyRes.stderr.trim()} — the DATA restored fine, but ` +
          `PostgREST/Studio may not be able to read or write it until this is fixed by hand.`,
      );
      return;
    }
    emit(
      "info",
      `re-asserted ownership and privileges for ${DATA_ACCESS_ROLES.join(", ")} on ` +
        schemas.join(", "),
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

/**
 * Custom-format (`pg_dump -Fc`) archives always begin with this 5-byte ASCII
 * magic (`K_MAGIC` in Postgres' own `pg_backup_archiver.c`) — the one
 * reliable way to tell a binary dump from a plain-text SQL one. The file
 * extension a caller uploaded it under is not: `pg_dump`'s DEFAULT format is
 * plain-text SQL unless `-Fc`/`-Fd`/`-Ft` was explicitly passed, so a
 * `.backup`/`.dump`-named file is very commonly plain SQL in practice (a
 * mislabeling this codebase must not trust — see restore.ts's use of this).
 */
const CUSTOM_FORMAT_MAGIC = Buffer.from("PGDMP", "ascii");

/** True when `buffer` is a `pg_restore`-compatible custom-format archive. */
export function looksLikeCustomFormatDump(buffer: Buffer): boolean {
  return buffer.subarray(0, CUSTOM_FORMAT_MAGIC.length).equals(CUSTOM_FORMAT_MAGIC);
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

export interface LoadDumpResult {
  /** Exit code (null when the channel closed without one). */
  code: number | null;
  /**
   * How many statements the tool reported failing.
   *
   * pg_restore ends a tolerant run with `errors ignored on restore: N`; psql
   * has no such summary, so its `ERROR:` lines are counted instead. Either
   * way a non-zero value means objects in the dump did NOT get created —
   * which a non-zero exit code alone cannot distinguish from harmless
   * ownership noise. Callers use it to tell a partial restore from a clean
   * one.
   */
  failedStatements: number;
}

/** `errors ignored on restore: N` (pg_restore) or the count of `ERROR:` lines (psql). */
export function countFailedStatements(output: string, isSql: boolean): number {
  if (isSql) return (output.match(/^\s*(?:psql:[^\s]*\s*)?ERROR:/gim) ?? []).length;
  const summary = /errors ignored on restore:\s*(\d+)/i.exec(output);
  if (summary) return Number.parseInt(summary[1]!, 10);
  // Fallback for a run where pg_restore printed errors but no summary line.
  return (output.match(/^pg_restore:\s*error:/gim) ?? []).length;
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
 * Returns the exit code plus how many statements actually failed, so a caller
 * can tell a tolerable run from one that silently dropped objects.
 */
export async function loadDumpIntoTarget(
  conn: SshConnection,
  target: TargetContainer,
  opts: LoadDumpOptions,
  emit: EmitFn,
): Promise<LoadDumpResult> {
  const flags = opts.flags ?? FULL_RESTORE_FLAGS;
  const cmd = opts.isSql
    ? `psql -U ${target.user} -d postgres -f ${opts.containerPath}`
    : `pg_restore -U ${target.user} -d postgres ${flags.join(" ")} ${opts.containerPath}`;

  const res = await exec(conn, `${target.compose} exec -T ${target.pgEnv} db ${cmd}`, {
    timeoutMs: RESTORE_TIMEOUT_MS,
  });
  const output = `${res.stdout}\n${res.stderr}`;
  emitCapturedOutput(emit, output);
  const failedStatements = countFailedStatements(output, !!opts.isSql);

  if (res.code !== 0) {
    const tool = opts.isSql ? "psql" : "pg_restore";
    const what = opts.label ? `${tool} (${opts.label})` : tool;
    emit(
      "info",
      `${what} exited with code ${res.code}` +
        (failedStatements > 0
          ? ` and reported ${failedStatements} failed statement(s) — objects in the dump ` +
            "were NOT created. Ownership/role warnings alone would not do this; the usual " +
            "cause is a type or function from an extension the target does not have."
          : " — no statement actually failed, so this is just cross-environment " +
            "ownership/role noise.") +
        " Review the output above." +
        (opts.snapshotPath
          ? ` The pre-restore snapshot at ${opts.snapshotPath} can be used to revert if ` +
            "the data doesn't look right."
          : ""),
    );
  }
  return { code: res.code, failedStatements };
}
