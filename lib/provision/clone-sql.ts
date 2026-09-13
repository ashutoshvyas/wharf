/** SQL builders kept dependency-free for the disposable PostgreSQL smoke test. */
function ident(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
function literal(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

export const CLONE_RESTORE_FLAGS = ["--exit-on-error", "--single-transaction"] as const;

/** Preserve destination database identity, including owner and locale. */
export function renderCreateStageSql(stage: string): string {
  return `SELECT format('CREATE DATABASE %I TEMPLATE template0 OWNER %I ENCODING %L LOCALE_PROVIDER %s LC_COLLATE %L LC_CTYPE %L %s CONNECTION LIMIT %s',
    ${literal(stage)}, pg_get_userbyid(datdba), pg_encoding_to_char(encoding),
    CASE datlocprovider WHEN 'i' THEN 'icu' WHEN 'b' THEN 'builtin' ELSE 'libc' END,
    datcollate, datctype,
    CASE WHEN datlocprovider = 'i' THEN format('ICU_LOCALE %L', coalesce(to_jsonb(d)->>'datlocale', to_jsonb(d)->>'daticulocale'))
         WHEN datlocprovider = 'b' THEN format('BUILTIN_LOCALE %L', to_jsonb(d)->>'datlocale') ELSE '' END,
    datconnlimit)
  FROM pg_database d WHERE datname = 'postgres'
\\gexec
`;
}

/** Run on the destination: values never transit through the panel or logs. */
export function renderPreserveDatabaseSettingsSql(stage: string): string {
  return `SELECT CASE WHEN s.setrole = 0
    THEN format('ALTER DATABASE %I SET %I TO %L', ${literal(stage)}, split_part(setting, '=', 1), substr(setting, strpos(setting, '=') + 1))
    ELSE format('ALTER ROLE %I IN DATABASE %I SET %I TO %L', pg_get_userbyid(s.setrole), ${literal(stage)}, split_part(setting, '=', 1), substr(setting, strpos(setting, '=') + 1)) END
  FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) setting
  WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = 'postgres')
\\gexec
REVOKE ALL ON DATABASE ${ident(stage)} FROM PUBLIC;
SELECT format('GRANT %s ON DATABASE %I TO %s%s', a.privilege_type, ${literal(stage)},
    CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
    CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
  FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
  WHERE d.datname = 'postgres'
\\gexec
`;
}

/** Both renames are transactional. The caller connects to template1. */
export function renderSwapSql(stage: string, previous: string): string {
  return `BEGIN;
ALTER DATABASE postgres RENAME TO ${ident(previous)};
ALTER DATABASE ${ident(stage)} RENAME TO postgres;
ALTER DATABASE postgres ALLOW_CONNECTIONS true;
COMMIT;
`;
}

/** Restore the original database and keep the failed clone under its stage name. */
export function renderRollbackSql(stage: string, previous: string): string {
  return `BEGIN;
ALTER DATABASE postgres RENAME TO ${ident(stage)};
ALTER DATABASE ${ident(previous)} RENAME TO postgres;
ALTER DATABASE postgres ALLOW_CONNECTIONS true;
COMMIT;
`;
}
