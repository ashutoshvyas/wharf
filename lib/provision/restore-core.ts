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
import { exec } from "@/lib/ssh";

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
  const dumpRes = await exec(
    conn,
    `${target.compose} exec -T ${target.pgEnv} db pg_dump -U postgres -Fc -d postgres ` +
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
    ? `psql -U postgres -d postgres -f ${opts.containerPath}`
    : `pg_restore -U postgres -d postgres ${flags.join(" ")} ${opts.containerPath}`;

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
