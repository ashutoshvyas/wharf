/**
 * Real PostgreSQL clone smoke test. Every database is disposable, created by
 * this process in two private temporary clusters with TCP disabled. It never
 * reads .env or connects to a configured WHARF database/server.
 *
 * WHARF_CLONE_PG_BIN=/path/to/postgres/bin \
 *   npx tsx scripts/check-clone-postgres.ts
 *
 * If client tools live elsewhere, set WHARF_CLONE_PG_CLIENT_BIN too. Both
 * directories must contain PostgreSQL 17 tools; no dependencies are installed
 * by this script. Tested with PostgreSQL 17.6 on macOS arm64.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CLONE_RESTORE_FLAGS,
  renderCreateStageSql,
  renderPreserveDatabaseSettingsSql,
  renderRollbackSql,
  renderSwapSql,
} from "../lib/provision/clone-sql";

const serverBin = process.env.WHARF_CLONE_PG_BIN;
if (!serverBin) {
  console.error("Set WHARF_CLONE_PG_BIN to a PostgreSQL 17 bin directory; this test creates its own temporary clusters.");
  process.exit(1);
}
const pgServerBin: string = serverBin;
const clientBin: string = process.env.WHARF_CLONE_PG_CLIENT_BIN ?? pgServerBin;
const binaries: Record<string, string> = Object.fromEntries(
  ["initdb", "pg_ctl", "postgres", "psql", "pg_dump", "pg_restore"].map((name) => {
    const directory = ["initdb", "pg_ctl", "postgres"].includes(name) ? pgServerBin : clientBin;
    const binary = resolve(directory, name);
    accessSync(binary, constants.X_OK);
    return [name, binary];
  }),
);

// Never inherit libpq connection strings/passwords or application credentials.
const cleanEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  NODE_ENV: "test" as const,
  LANG: "C",
  LC_ALL: "C",
};

function run(binary: string, args: readonly string[], input?: string): string {
  return execFileSync(binaries[binary]!, [...args], {
    input,
    encoding: "utf8",
    env: cleanEnv,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

for (const name of ["postgres", "pg_dump", "pg_restore"]) {
  assert.match(run(name, ["--version"]), /\b17\./, `${name} must be PostgreSQL 17`);
}

const temporaryRoot = mkdtempSync("/tmp/wharf-clone-check-");
const stage = "wharf_clone_fixture";
const previous = "wharf_previous_fixture";
type Cluster = { data: string; socket: string; started: boolean };
const clusters: Cluster[] = [];

function startCluster(name: string): Cluster {
  const cluster = {
    data: join(temporaryRoot, name),
    socket: join(temporaryRoot, `${name}-socket`),
    started: false,
  };
  clusters.push(cluster);
  mkdirSync(cluster.socket, { mode: 0o700 });
  run("initdb", ["-D", cluster.data, "-U", "supabase_admin", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  run("pg_ctl", ["-D", cluster.data, "-l", join(temporaryRoot, `${name}.log`), "-o",
    `-c listen_addresses='' -c unix_socket_directories='${cluster.socket}' -c port=5432 -c wal_level=logical`,
    "-w", "-t", "30", "start"]);
  cluster.started = true;
  return cluster;
}

function connection(cluster: Cluster, database = "postgres"): string[] {
  return ["-h", cluster.socket, "-p", "5432", "-U", "supabase_admin", "-d", database, "--no-password"];
}

function sql(cluster: Cluster, text: string, database = "postgres"): string {
  return run("psql", [...connection(cluster, database), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"], text);
}

function expectSql(cluster: Cluster, text: string, expected: string, description: string, database = "postgres") {
  assert.equal(sql(cluster, text, database), expected, description);
}

function dump(cluster: Cluster, file: string, extra: string[] = []) {
  // Compression is irrelevant to the semantics and permits minimal local clients.
  run("pg_dump", [...connection(cluster), "-Fc", "-Z0", "-f", file, ...extra]);
}

function restore(cluster: Cluster, file: string, extra: string[] = []) {
  run("pg_restore", [...connection(cluster, stage), ...CLONE_RESTORE_FLAGS, ...extra, file]);
}

function disconnectForSwap(cluster: Cluster, database = "postgres") {
  // The connection fence must commit BEFORE terminating connections/renaming.
  sql(cluster, `ALTER DATABASE "${database}" ALLOW_CONNECTIONS false;`, "template1");
  sql(cluster, `SELECT pg_terminate_backend(pid, 10000) FROM pg_stat_activity WHERE datname = '${database}';`, "template1");
}

function expectFailure(action: () => unknown, pattern: RegExp, message: string) {
  try { action(); } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    assert.match(stderr, pattern, message);
    return;
  }
  assert.fail(message);
}

try {
  const source = startCluster("source");
  const target = startCluster("target");
  const baseline = `
    CREATE ROLE postgres LOGIN PASSWORD 'fixture-postgres';
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE authenticator LOGIN PASSWORD 'fixture-authenticator';
    GRANT anon, authenticated, service_role TO authenticator;
    ALTER DATABASE postgres OWNER TO postgres;
    CREATE SCHEMA _realtime;
    CREATE TABLE _realtime.tenants (name text PRIMARY KEY, jwt_secret text NOT NULL);
  `;
  sql(source, baseline);
  sql(target, baseline);
  sql(source, `
    ALTER ROLE postgres PASSWORD 'source-fixture-password';
    ALTER DATABASE postgres SET "app.settings.jwt_secret" = 'source-fixture-jwt';
    INSERT INTO _realtime.tenants VALUES ('source', 'source-fixture-jwt');
    CREATE SCHEMA auth AUTHORIZATION postgres;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text UNIQUE);
    CREATE TABLE auth.identities (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES auth.users, provider text NOT NULL);
    INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001', 'fixture@example.test');
    INSERT INTO auth.identities (user_id, provider) SELECT id, 'email' FROM auth.users;
    CREATE SCHEMA storage AUTHORIZATION postgres;
    CREATE TABLE storage.buckets (id text PRIMARY KEY);
    CREATE TABLE storage.objects (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      bucket_id text REFERENCES storage.buckets, name text NOT NULL);
    INSERT INTO storage.buckets VALUES ('fixture');
    INSERT INTO storage.objects (bucket_id, name) VALUES ('fixture', 'fixture.txt');
    CREATE SCHEMA app AUTHORIZATION postgres;
    CREATE TYPE app.order_state AS ENUM ('open', 'closed');
    CREATE TABLE app.orders (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id uuid REFERENCES auth.users, state app.order_state DEFAULT 'open',
      detail jsonb NOT NULL, changed boolean DEFAULT false);
    ALTER TABLE app.orders OWNER TO postgres;
    INSERT INTO app.orders (user_id, detail) SELECT id, '{"unicode":"Cloning ✓","nested":[1,2]}' FROM auth.users;
    SELECT setval('app.orders_id_seq', 40);
    CREATE INDEX orders_detail ON app.orders USING gin (detail);
    CREATE FUNCTION app.mark_changed() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.changed := true; RETURN NEW; END $$;
    CREATE TRIGGER order_changed BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.mark_changed();
    CREATE VIEW app.open_orders AS SELECT id FROM app.orders WHERE state = 'open';
    CREATE MATERIALIZED VIEW app.order_count AS SELECT count(*) AS n FROM app.orders;
    ALTER TABLE app.orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY read_own_order ON app.orders FOR SELECT TO authenticated USING
      (user_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);
    GRANT USAGE ON SCHEMA app TO authenticated;
    GRANT SELECT ON app.orders TO authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT SELECT ON TABLES TO authenticated;
    CREATE TABLE public.files (id int PRIMARY KEY, body oid);
    INSERT INTO public.files VALUES (1, lo_from_bytea(90001, decode('000102ff00', 'hex')));
    CREATE PUBLICATION fixture_publication FOR TABLE app.orders;
  `);
  sql(target, `
    ALTER ROLE postgres PASSWORD 'target-fixture-password';
    ALTER DATABASE postgres SET "app.settings.jwt_secret" = 'target-fixture-jwt';
    ALTER ROLE authenticator IN DATABASE postgres SET "pgrst.db_schemas" = 'public,app';
    REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
    GRANT CONNECT ON DATABASE postgres TO authenticator;
    INSERT INTO _realtime.tenants VALUES ('target', 'target-fixture-jwt');
    CREATE SCHEMA target_only;
    CREATE TABLE target_only.retained_in_backup (value text);
    INSERT INTO target_only.retained_in_backup VALUES ('original-target-data');
    CREATE TABLE public.obsolete (id int);
    INSERT INTO public.obsolete VALUES (10);
  `);
  const targetPassword = sql(target, "SELECT rolpassword FROM pg_authid WHERE rolname = 'postgres';");
  const sourcePassword = sql(source, "SELECT rolpassword FROM pg_authid WHERE rolname = 'postgres';");
  const sourceArchive = join(temporaryRoot, "source.backup");
  const safetyArchive = join(temporaryRoot, "target-before.backup");
  const runtimeArchive = join(temporaryRoot, "target-runtime.backup");
  dump(source, sourceArchive, ["--exclude-schema=_realtime"]);
  dump(target, safetyArchive);
  dump(target, runtimeArchive, ["--schema=_realtime"]);

  // A role that only exists in the source makes restore fail strictly, while
  // the destination's current database stays untouched and connectable.
  sql(source, "CREATE ROLE source_only; CREATE TABLE public.requires_missing_role (id int); ALTER TABLE public.requires_missing_role OWNER TO source_only;");
  const incompatibleArchive = join(temporaryRoot, "missing-role.backup");
  dump(source, incompatibleArchive, ["--exclude-schema=_realtime"]);
  sql(target, renderCreateStageSql(stage), "template1");
  expectFailure(() => restore(target, incompatibleArchive), /role "source_only" does not exist/, "missing roles must abort restore");
  expectSql(target, "SELECT value FROM target_only.retained_in_backup;", "original-target-data", "failed staging preserves target");
  expectSql(target, "SELECT to_regclass('app.orders') IS NULL;", "t", "failed restore is transactional", stage);
  sql(target, `DROP DATABASE ${stage};`, "template1");

  // Restore schema/data and separately carry destination runtime identity.
  sql(target, renderCreateStageSql(stage), "template1");
  restore(target, sourceArchive);
  restore(target, runtimeArchive);
  sql(target, renderPreserveDatabaseSettingsSql(stage), "template1");
  expectSql(target, "SELECT to_regclass('target_only.retained_in_backup') IS NULL;", "t", "fresh staging excludes target-only objects", stage);
  expectSql(target, "SELECT jwt_secret FROM _realtime.tenants WHERE name = 'target';", "target-fixture-jwt", "destination realtime identity retained", stage);
  expectSql(target, 'SHOW "app.settings.jwt_secret";', "target-fixture-jwt", "database identity settings copied", stage);

  // Failure of the SECOND rename must roll back the FIRST rename as well.
  disconnectForSwap(target);
  expectFailure(() => sql(target, renderSwapSql("missing_stage", previous), "template1"), /database "missing_stage" does not exist/, "second rename failure must abort activation");
  expectSql(target, `SELECT count(*) FROM pg_database WHERE datname = 'postgres';`, "1", "atomic rename leaves original database name", "template1");
  expectSql(target, `SELECT count(*) FROM pg_database WHERE datname = '${previous}';`, "0", "failed activation does not leave half-renamed database", "template1");
  sql(target, "ALTER DATABASE postgres ALLOW_CONNECTIONS true;", "template1");
  expectSql(target, "SELECT value FROM target_only.retained_in_backup;", "original-target-data", "original data survives swap failure");

  disconnectForSwap(target);
  disconnectForSwap(target, stage);
  sql(target, renderSwapSql(stage, previous), "template1");
  expectSql(target, "SELECT email FROM auth.users;", "fixture@example.test", "auth users copied");
  expectSql(target, "SELECT provider FROM auth.identities;", "email", "auth identities copied");
  expectSql(target, "SELECT name FROM storage.objects;", "fixture.txt", "storage metadata copied");
  expectSql(target, "SELECT detail->>'unicode' FROM app.orders;", "Cloning ✓", "application JSON/Unicode data copied");
  expectSql(target, "SELECT nextval('app.orders_id_seq');", "41", "sequence state copied");
  expectSql(target, "SELECT count(*) FROM app.open_orders;", "1", "view works after restore");
  expectSql(target, "SELECT n FROM app.order_count;", "1", "materialized view data copied");
  expectSql(target, "SELECT encode(lo_get(body), 'hex') FROM public.files;", "000102ff00", "large object bytes copied");
  expectSql(target, "SELECT count(*) FROM pg_publication WHERE pubname = 'fixture_publication';", "1", "publication definition copied");
  expectSql(target, "SELECT count(*) FROM pg_policies WHERE schemaname = 'app' AND policyname = 'read_own_order';", "1", "RLS policy copied");
  expectSql(target, "SELECT relrowsecurity FROM pg_class WHERE oid = 'app.orders'::regclass;", "t", "RLS remains enabled");
  expectSql(target, "SELECT has_table_privilege('authenticated', 'app.orders', 'SELECT');", "t", "source table grants retained");
  expectSql(target, "SELECT has_table_privilege('anon', 'app.orders', 'SELECT');", "f", "clone does not broaden source access");
  expectSql(target, "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'app.orders'::regclass;", "postgres", "table owner retained");
  expectSql(target, "SET ROLE authenticated; SELECT count(*) FROM app.orders;", "0", "restored policy denies anonymous subject");
  expectSql(target, "SET ROLE authenticated; SET request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001'; SELECT count(*) FROM app.orders;", "1", "restored policy permits matching subject");
  expectSql(target, "UPDATE app.orders SET state = 'closed'; SELECT changed FROM app.orders;", "t", "restored trigger executes");
  sql(target, "SET ROLE postgres; CREATE TABLE app.after_clone (id int);");
  expectSql(target, "SELECT has_table_privilege('authenticated', 'app.after_clone', 'SELECT');", "t", "default privileges preserved");
  expectSql(target, "SELECT to_regclass('public.obsolete') IS NULL AND to_regclass('target_only.retained_in_backup') IS NULL;", "t", "target-only schema and tables are replaced");
  expectSql(target, 'SHOW "app.settings.jwt_secret";', "target-fixture-jwt", "target JWT identity preserved after activation");
  expectSql(target, "SELECT jwt_secret FROM _realtime.tenants;", "target-fixture-jwt", "source runtime tenant excluded");
  expectSql(target, "SELECT setconfig[1] FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = 'postgres') AND setrole = 'authenticator'::regrole;", "pgrst.db_schemas=public,app", "role-in-database settings follow replacement OID");
  expectSql(target, "SELECT has_database_privilege('anon', 'postgres', 'CONNECT');", "f", "destination database ACL retained");
  expectSql(target, "SELECT rolpassword FROM pg_authid WHERE rolname = 'postgres';", targetPassword, "destination credentials unchanged");
  expectSql(source, "SELECT rolpassword FROM pg_authid WHERE rolname = 'postgres';", sourcePassword, "source credentials unchanged");
  expectSql(source, "SELECT state::text || ':' || changed::text FROM app.orders;", "open:false", "clone leaves source data unchanged");
  console.log("PASS: schema/data, auth, storage metadata, RLS/grants, owners, default privileges, triggers, views, sequences, large objects, runtime settings, credentials, source isolation.");

  // A failed post-activation health check can restore the intact old DB.
  disconnectForSwap(target);
  sql(target, renderRollbackSql(stage, previous), "template1");
  expectSql(target, "SELECT value FROM target_only.retained_in_backup;", "original-target-data", "activation rollback restores original data");
  expectSql(target, "SELECT to_regclass('app.orders') IS NULL;", "t", "rollback removes clone from active destination");
  expectSql(target, 'SHOW "app.settings.jwt_secret";', "target-fixture-jwt", "rollback retains target identity");
  console.log("PASS: missing-role failure preserves target; atomic rename failure preserves original name/data; post-activation rollback restores target.");
} finally {
  let stopped = true;
  for (const cluster of clusters.reverse()) {
    if (!cluster.started) continue;
    try { run("pg_ctl", ["-D", cluster.data, "-m", "immediate", "-w", "-t", "30", "stop"]); }
    catch { stopped = false; console.error(`Could not stop temporary cluster at ${cluster.data}; retained its directory for cleanup.`); }
  }
  if (stopped) rmSync(temporaryRoot, { recursive: true, force: true });
}
