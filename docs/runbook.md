# WHARF operations runbook

For the person on call. Assumes no prior knowledge of the codebase.

- **Setting a deployment up for the first time?** → `docs/deployment.md`
  (domains, DNS, SSO chain) then `deploy/README.md` (install steps).
- **Something is broken?** → jump to [Scenario playbooks](#scenario-playbooks).
- **Need a fact fast?** → [Quick reference](#quick-reference).

Two lines of orientation, because they change what "urgent" means:

> The panel is a **control plane**. Live traffic to hosted websites and to
> provisioned Supabase instances never passes through it — Traefik on each
> managed server routes that directly. **If the panel is down, everything it
> manages keeps running.** A panel outage is a management outage, not a
> customer outage.

> The **one irreplaceable thing** is `WHARF_MASTER_KEY`. Database backups are
> ciphertext without it. See [Known operational truths](#known-operational-truths).

---

## Deploy checklist

`docs/deployment.md` is the authority on all of this; this is the checklist
form, with the traps called out.

- [ ] **Wildcard DNS per database server.** `*.INSTANCE_DOMAIN` A record →
      **the database server's** IP, not the panel's. One record per database
      server; each managed server that hosts databases runs its own Traefik
      and needs its own wildcard. Plus `panel.<apex>` A → panel VPS. This is
      the system's only manual DNS prerequisite.
      Verify: `dig +short anything-at-all.$INSTANCE_DOMAIN` returns the
      database server IP.
- [ ] **`COOKIE_DOMAIN` / `INSTANCE_DOMAIN` share an apex, and `PANEL_URL`
      sits under it.** `COOKIE_DOMAIN=".wharf.example.com"`,
      `INSTANCE_DOMAIN="wharf.example.com"`, `PANEL_URL="https://panel.wharf.example.com"`.
      Host the panel on a different apex and Studio SSO fails as an infinite
      login bounce with nothing in any log. `lib/config-check.ts` catches this
      at boot — grep the journal for `configuration problems` after every
      deploy. Leave `COOKIE_DOMAIN` empty in local development only.
- [ ] **Master key generated and stored.** `openssl rand -base64 32`, exactly
      32 bytes decoded. Into `/etc/wharf/.env`, and a copy into a password
      manager / KMS **that is not this VPS and not where the DB dumps live**.
      Rotating it later is possible (`scripts/rotate-key.ts`) but needs both
      keys — losing the old one is terminal.
- [ ] **`NEXTAUTH_SECRET` generated** and identical for panel and gateway
      (they share `/etc/wharf/.env`, so this is automatic — keep it that way;
      the gateway verifies the panel's session JWT with it).
- [ ] **Both database URLs set.** `DATABASE_URL` pooled (6543,
      `pgbouncer=true`), `DIRECT_URL` direct (5432), both `sslmode=require`.
      See `deploy/README.md` → "Connecting to the Supabase Postgres".
- [ ] **Migrations applied and admin seeded.** `npm run db:check` →
      `npm run db:deploy` → `npm run db:seed`. Change `ADMIN_PASSWORD` from
      the `.env.example` placeholder before seeding, and log in once to prove it.
- [ ] **Static assets copied into the standalone bundle.** `deploy/deploy.sh`
      does it; a hand-built deploy must (see `deploy/README.md` step 5).
      Otherwise: an unstyled login page with every JS chunk 404ing.
- [ ] **The build saw the environment.** `INSTANCE_DOMAIN` and
      `NEXT_PUBLIC_GATEWAY_WS_URL` are baked into the CSP at build time. Build
      without them and Manage shows a blank frame with a clean server log.
      `deploy.sh` sources `/etc/wharf/.env` and asserts the result; verify by
      hand after any manual build (see
      [Build-time vs restart-time](#build-time-vs-restart-time)).
- [ ] **Backups running.** `deploy/backup.sh` in root's crontab, and one
      `deploy/restore.sh --dry-run` executed against the newest dump.
- [ ] **Verification pass.** Run all eight steps of `docs/deployment.md` →
      "Verifying a deployment". Step 7 (Studio loads in-panel with no second
      login) is the only end-to-end proof of the forwardAuth chain.

---

## Scenario playbooks

### 1. Host key changed — a server is hard-blocked

**Symptom.** Every action against one server fails with
`Host key changed for server <id>: expected SHA256:…, got SHA256:…`. The
server card shows unreachable. The terminal closes immediately with
`host key changed — refusing to connect (possible MITM)` (close code 4003).
Provisioning, bootstrap, stop/start — all of it, on that server only.

**Why.** WHARF pins the SSH host key on first successful connect (TOFU,
`lib/ssh.ts`). A mismatch is either a rebuilt/reimaged host, a changed SSH
daemon key, a different machine now answering that IP — or an actual
man-in-the-middle. WHARF refuses to guess, and there is deliberately **no
automatic re-pin**.

**Step 1 — get both fingerprints.** The error carries them; so does the
journal:

```bash
journalctl -u wharf-panel --since "1 hour ago" | grep -i "host key changed"
# Host key changed for server 6c1f…: expected SHA256:AbC…, got SHA256:XyZ…
```

**Step 2 — verify the new key out of band.** Not from the panel, not over the
same network path you are suspicious of. Best to worst:

```bash
# Best: on the server's console (hosting provider's web console / IPMI):
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
#   256 SHA256:XyZ… root@dbhost (ED25519)

# Acceptable: your provider's control panel shows host key fingerprints.
# Weakest: from a different network, and only if you can explain the change.
ssh-keyscan -t ed25519 <host> 2>/dev/null | ssh-keygen -lf -
```

The printed fingerprint must equal the `got SHA256:…` value **character for
character**. If it does not, or you cannot explain why the key changed, stop:
treat it as a compromise, rotate that server's SSH credentials, and do not
clear the pin.

**Step 3 — clear the pin.** ⚠️ There is currently **no UI or API for this**
(see [Gaps](#gaps-an-operator-still-has-to-work-around)). It is a direct
database update against `DIRECT_URL`, with the panel running:

```bash
set -a; . /etc/wharf/.env; set +a

# Confirm you have the right server first — never clear by guesswork.
psql "$DIRECT_URL" -c \
  "select id, name, host, host_key_fingerprint, reachable from servers order by name;"

psql "$DIRECT_URL" -c \
  "update servers set host_key_fingerprint = null, reachable = true
   where id = '<server-uuid>';"
# UPDATE 1
```

**Step 4 — re-pin and confirm.** In the panel, open the server and hit the
reachability check (or `POST /api/servers/:id/check`). The next successful
connection re-pins the new key (TOFU again).

```bash
curl -s http://127.0.0.1:3000/api/healthz   # panel is up
# then, in the UI: Servers → <server> → Check → "Host key … ✓ pinned"
```

The server detail page must now show the **new** fingerprint with `✓ pinned`.
Open the Terminal tab and run `id` — that is the proof the whole SSH path
works again.

**Step 5 — record it.** The DB update is not audited (it bypassed the API).
Note in your own change log: who verified the fingerprint, how, and when.

---

### 2. Panel lost — restore the database

**Symptom.** The VPS is gone, the database was wiped, or the panel starts but
its tables are empty. Managed servers and every provisioned Supabase instance
are **unaffected and still serving traffic** — you are restoring the control
plane's memory, not the workloads.

**Before you touch anything, answer one question:**

> **Do I have the `WHARF_MASTER_KEY` that was in force when this dump was
> taken?**

If no — the dump gets you a panel that logs in, lists servers, websites and
instances, and **cannot open a single SSH connection or reveal a single
secret**, forever. Every `*_enc` column is AES-256-GCM ciphertext and the key
is not in the dump. In that case the recovery is manual: re-enter SSH
credentials for each server by hand, and pull each instance's Supabase secrets
off the server from `/opt/db-instances/sb_xxxx/.env` over SSH.

If yes — continue.

```bash
# 1. Rebuild the box if needed: deploy/README.md "First-time install",
#    steps 1-3 and 6-7. Put the ORIGINAL WHARF_MASTER_KEY into /etc/wharf/.env.

# 2. Pick a dump and verify it WITHOUT touching the database.
ls -lh /var/backups/wharf/
sudo /opt/wharf/deploy/restore.sh --dry-run /var/backups/wharf/wharf-YYYYMMDD-HHMM.dump
#   ✓ archive is readable — N TABLE entries in its table of contents
#   · dry run — nothing was connected to and nothing was written.

# 3. Stop the services (restore.sh refuses while they run).
sudo systemctl stop wharf-panel wharf-gateway

# 4. Restore. Type RESTORE at the prompt.
sudo /opt/wharf/deploy/restore.sh /var/backups/wharf/wharf-YYYYMMDD-HHMM.dump
#   ✓ restore complete

# 5. Verify.
cd /opt/wharf && npm run db:check
#   ✓ Connected (…ms)   … all migrations applied
sudo systemctl start wharf-panel wharf-gateway
curl -s http://127.0.0.1:3000/api/healthz    # {"ok":true,"service":"wharf-panel"}
```

**The real acceptance test is not `db:check`.** Open any server's Terminal tab
and run `id`. That decrypts a stored SSH credential with the current master
key. If it works, the key matches the dump and the restore is genuinely good.
If it fails with a decryption error, the key does **not** match — stop, put
the correct key in `/etc/wharf/.env`, restart, and try again.

Then reconcile: any instance provisioned **after** the dump was taken exists
on the server but has no row in the panel. It will surface as an orphan —
playbook 4.

---

### 3. Let's Encrypt is not issuing certificates

**Symptom.** An instance is `running` in the panel (health checks are
server-local and passed), but `https://{slug}.INSTANCE_DOMAIN` returns a TLS
error, a Traefik default certificate, or times out.

First: **wait a minute.** Certificates are issued on the *first request* to
each new subdomain (HTTP-01, on demand). A fresh instance legitimately has no
certificate until someone asks for one, and issuance takes seconds to a minute.
This is expected behaviour, not a fault (architecture §7).

If it persists, check in this order — on the **database server**, not the
panel VPS:

```bash
# a) Port 80 reachable from the internet. HTTP-01 requires it; 443 alone
#    is not enough. This is the single most common cause.
curl -sI http://{slug}.$INSTANCE_DOMAIN/.well-known/acme-challenge/probe
#   expect an HTTP response (404 from Traefik is FINE — it proves reachability)
#   a hang or "Connection refused" means a firewall/security group is blocking 80

ssh root@<database-server>
ss -ltnp | grep -E ':(80|443)\b'      # traefik must own both
ufw status                            # 80/443 ALLOW, if ufw is in use

# b) DNS actually resolves to this server.
dig +short {slug}.$INSTANCE_DOMAIN    # must equal this server's public IP
dig +short '*.'$INSTANCE_DOMAIN       # the wildcard itself

# c) acme.json permissions. Traefik REFUSES to use it if it is not 0600
#    and logs "permissions 644 for /acme.json are too open".
ls -l /opt/wharf/traefik/acme.json
#   -rw------- 1 root root … acme.json
chmod 600 /opt/wharf/traefik/acme.json    # if wrong
docker restart $(docker ps -qf name=traefik)

# d) What Traefik actually says.
docker logs --tail 100 $(docker ps -qf name=traefik) 2>&1 | grep -i acme
```

**Rate limits.** Let's Encrypt allows **50 certificates per registered domain
per week** and **5 duplicate certificates per week**. Provisioning and
removing test instances under one apex burns through the duplicate limit fast.
The log line is unmistakable:
`too many certificates (5) already issued for this exact set of identifiers`.
There is no override and no appeal — the counter is a rolling 7-day window.
Check your position at <https://crt.sh/?q=%25.yourdomain.tld>. While you wait,
the instance still works over its own IP/port from inside the server; the
public subdomain does not.

**Wrong email / registration.** `LETSENCRYPT_EMAIL` is baked into
`/opt/wharf/traefik/traefik.yml` when the server is prepared. Changing it in
`/etc/wharf/.env` does **not** reach the server on its own — re-run bootstrap
against that server (`POST /api/servers/:id/bootstrap`, admin only), which
re-uploads the Traefik config. That is the documented purpose of the manual
bootstrap re-run.

---

### 4. Stuck provisioning, and orphaned compose projects

**Two different problems. Do not confuse them.**

#### 4a. A row stuck in `provisioning` or `removing`

The provisioning engine runs **inside the panel process** and keeps job state
in memory. Restart the panel mid-job and the row is stranded.

This heals itself: `instrumentation.ts` runs a boot sweep
(`lib/instances/recovery.ts → sweepStaleJobs`) that flips any
`provisioning`/`removing` row untouched for **10 minutes**, and with no live
job behind it, to `error` with the note
`✗ interrupted — panel restarted before this job finished`. The liveness check
is what makes it safe: a genuinely long provision is never swept out from
under itself.

```bash
# Force the sweep by restarting the panel (it runs at boot, once).
sudo systemctl restart wharf-panel
journalctl -u wharf-panel -n 50 --no-pager | grep -i -E 'sweep|interrupted'
```

Then, in the UI, use **Retry** — the pipeline is idempotent (`docker compose
up -d` re-converges), so retrying is safe. Or **Remove** if you would rather
start clean. There is no silent auto-retry anywhere, by design.

If a row is stuck *and* less than 10 minutes old, it is probably still running.
Watch the live log (`/api/db-instances/:id/provision-log`, the log pane in the
UI) before doing anything. The health poll alone is capped at 3–5 minutes.

#### 4b. Orphans — compose projects on a server with no row

A compose project named `sb_xxxx` running on a server that no instance row
claims. Causes: the panel died after `docker compose up -d` but before the row
was finalised; a row was deleted by hand; or a database restore rolled the
panel back past instances that were created after the dump.

```bash
# Read-only diagnostic over SSH. Admin role. Slow, and fails loudly (500)
# if the server is unreachable.
curl -s -b "$PANEL_COOKIE" \
  https://panel.$INSTANCE_DOMAIN/api/servers/<server-id>/orphans | jq
# {"orphans":[{"project":"sb_9f3a", ...}]}
```

It is also surfaced on the server detail page.

> **Resolution is MANUAL, always. Nothing in WHARF ever deletes an orphan
> automatically** (architecture §4.3), and neither should you, quickly. An
> orphan is a *running Supabase instance with real data in its volumes*. The
> panel simply forgot about it.

Decide deliberately:

```bash
ssh root@<server>
docker compose -p sb_9f3a ps                       # is it actually serving?
ls -la /opt/db-instances/sb_9f3a/
cat /opt/db-instances/sb_9f3a/.env                 # its secrets live here
docker compose -p sb_9f3a exec db psql -U postgres -c '\l'   # is there data?
```

- **Wanted, panel forgot it** (typical after a restore): the panel has no
  "adopt" flow. Keep it running, and either re-provision under a new slug and
  migrate the data, or leave it and document it. Do not delete.
- **Genuinely abandoned** (a failed provision that never finished): tear it
  down by hand, after confirming there is no data worth keeping.
  ```bash
  docker compose -p sb_9f3a down -v      # -v DESTROYS the volumes, permanently
  rm -rf /opt/db-instances/sb_9f3a
  ```

---

### 5. A server that cannot host databases (ports 80/443 already bound)

**Symptom.** The first provision onto a server aborts almost immediately, in
the `prepare` phase, with:

```
port 80 is in use by nginx — a database server must own ports 80 and 443
(see architecture §9). Use a dedicated server for databases.
```

**This is the system working.** Server preparation is lazy: it happens as the
first phase of the first provision onto that server, and the very first thing
it does is preflight (`lib/bootstrap/prepare.ts`). Preflight runs **before
anything is installed or written**, so a rejected host is left completely
untouched. Nothing was displaced; there was no outage risk.

**Why it cannot be worked around.** WHARF's routing model is Traefik owning
the edge on ports 80/443, with label-driven routers, on-demand Let's Encrypt
and forwardAuth gating of Studio. Docker cannot bind an already-bound port,
and an additional reverse proxy requires routing and certificate changes that
WHARF does not configure. Use a **dedicated database server** when another
service already owns those ports; see `docs/architecture.md` §9.

**What to do.**

1. Confirm what owns the ports:
   ```bash
   ssh root@<server> "ss -ltnp | grep -E ':(80|443)\b'"
   # LISTEN 0 511 *:80 *:* users:(("nginx",pid=812,fd=6))
   ```
2. Provision the database onto a **dedicated** server with nothing on 80/443,
   with its own `*.INSTANCE_DOMAIN` wildcard record.
3. **Keep the busy server registered.** General-purpose hosts that already
   serve web traffic remain fully useful in WHARF for the Websites module and
   the SSH terminal. They do not need bootstrap for those modules. Database
   provisioning checks suitability before installing anything and rejects
   hosts with occupied ports.

The other two preflight failures, same shape, same "host untouched" guarantee:

| Message | Fix |
|---|---|
| `the SSH user is not root and passwordless sudo is unavailable` | Connect as root, or grant that user `NOPASSWD` sudo. Preparation installs Docker and binds privileged ports. |
| `only X GB free on /opt — a Supabase instance needs at least 10 GB` | Free space, or mount a larger volume at `/opt`. |
| `could not list listening sockets` | Install `iproute2` (or `net-tools`) on the server and retry. |

---

### 6. Removing a server safely

**Symptom.** `DELETE /api/servers/:id` returns **409** with
`Server still has linked resources — {"websites":3,"dbInstances":1}`. The UI
refuses the delete.

**This is intentional.** Deleting the row would orphan every website record
and, worse, throw away the only encrypted copy of the SSH credentials needed
to reach the instances still running on that host.

Correct order:

1. **Instances first.** For each database instance on that server, use
   **Remove permanently** in the UI (admin only, type-the-name confirmation).
   Read the confirmation copy: this runs `docker compose down -v` and deletes
   the remote path — **the volume data is unrecoverable**, even though the
   metadata row lingers as a soft-delete for a grace period.
   Alternatively **Stop** them and move them to another server first: Stop
   preserves volumes.
2. **Websites next.** Delete each website record, or repoint it at another
   server (`PATCH /api/websites/:id`). Website records are pure metadata —
   deleting one does not touch a single file on the server.
3. **Then the server.**
   ```bash
   # Re-check what is still linked:
   psql "$DIRECT_URL" -c "
     select s.name,
            count(distinct w.id)  as websites,
            count(distinct d.id)  as instances
     from servers s
     left join websites w      on w.server_id = s.id
     left join db_instances d  on d.server_id = s.id and d.deleted_at is null
     where s.id = '<server-uuid>'
     group by s.name;"
   ```
   With both counts at zero, the delete succeeds and is audited
   (`server.delete`).

**Note:** soft-deleted instances (`deleted_at` set) still count against the
delete until they are purged. That is the grace period doing its job — wait it
out rather than clearing `deleted_at` by hand.

**Decommissioning the machine itself** is a separate act. WHARF's delete only
removes the panel's record; it never logs in to wipe the host. Do that
yourself, after the panel row is gone.

---

### 7. Rotating the master key

Rotate when the key may have been exposed, when someone with access leaves, or
on a policy schedule. `scripts/rotate-key.ts` re-encrypts every `*_enc` column
from an old key to a new one.

**Non-negotiables:**

- **Both keys are required, at the same time.** Lose the old key mid-rotation
  and every value not yet rotated is gone permanently.
- **Take a backup first**, and keep the **old** key with it. That backup is
  readable only under the old key.
- **Stop the panel and gateway.** Both hold the old key in memory and both
  write encrypted values; rotating underneath a live process is asking for a
  half-rotated row.
- **`--dry-run` first, every time.** It performs every decrypt check and
  writes nothing.
- The script is **idempotent**: it tries the NEW key first and skips anything
  that already opens with it, so a re-run after an interruption is safe.

```bash
# 0. Backup, and label it with the OLD key.
sudo /opt/wharf/deploy/backup.sh

# 1. Stop everything that holds the key.
sudo systemctl stop wharf-panel wharf-gateway

# 2. Generate the new key.
openssl rand -base64 32        # → NEW KEY. Save it somewhere safe NOW.

# 3. Dry run. NOTE: rotate-key.ts does NOT read /etc/wharf/.env by itself —
#    it needs DATABASE_URL in the environment, so source the file first.
cd /opt/wharf
set -a; . /etc/wharf/.env; set +a
WHARF_MASTER_KEY_OLD="<old-key>" \
WHARF_MASTER_KEY_NEW="<new-key>" \
  npx tsx scripts/rotate-key.ts --dry-run
#   Master-key rotation (dry run — no writes)
#     server                rotated=4 skipped=0 failed=0
#     website               rotated=2 skipped=0 failed=0
#     dbInstance            rotated=8 skipped=0 failed=0
#     instanceAuthSettings  rotated=3 skipped=0 failed=0
#     instanceSyncSource    rotated=2 skipped=0 failed=0
#   Summary: rotated=19 skipped=0 failed=0 (dry run — nothing was written)
```

One line per model that has encrypted columns — the exact set is
`scripts/rotation-targets.ts`, which `scripts/rotation-targets.test.ts` checks
against `prisma/schema.prisma` on every test run, so a newly added `*_enc`
column cannot go unrotated. A model with nothing configured yet reports all
zeroes rather than being absent.

**`failed` must be 0 before you proceed.** A non-zero `failed` means some
values open with *neither* key — those would be unrecoverable after the
switch. The script exits 1 and prints `Do NOT discard the old key.`
Investigate first.

```bash
# 4. Real run (same command, without --dry-run).
WHARF_MASTER_KEY_OLD="<old-key>" \
WHARF_MASTER_KEY_NEW="<new-key>" \
  npx tsx scripts/rotate-key.ts

# 5. Swap the key in the env file.
sudo sed -i 's|^WHARF_MASTER_KEY=.*|WHARF_MASTER_KEY="<new-key>"|' /etc/wharf/.env
sudo grep -c '^WHARF_MASTER_KEY=' /etc/wharf/.env    # 1

# 6. Start and PROVE it.
sudo systemctl start wharf-panel wharf-gateway
```

Acceptance test: open a server's Terminal and run `id`, then reveal one
instance's secrets in the UI. Both paths decrypt with the new key. Only after
that, retire the old key — and remember that **every backup taken before the
rotation still needs the old key**. Keep it archived with those dumps; do not
delete it.

---

### 8. Rolling back a release

```bash
cat /opt/wharf/deploy/.deployed-tag      # what is running
sudo /opt/wharf/deploy/deploy.sh v1.3.0  # previous tag
```

**Read this before you rely on it.**

| | Rolls back? |
|---|---|
| Application code (panel + gateway) | **Yes** — re-run `deploy.sh` with the previous tag, ~2 minutes. |
| Database migrations | **No.** There is no `prisma migrate down`. Rolling the code back leaves the new schema in place. |

That asymmetry is survivable only because migrations are required to be
**additive and backward-compatible within a release train**: add nullable
columns, add tables, add indexes. Never drop or rename a column, never narrow
a type, never add `NOT NULL` without a default, in the same release that
starts using it. Drop the old column one release *later*, once the previous
version is no longer a rollback target.

**If a release contains a destructive migration, `deploy.sh` is not a rollback
path.** The only way back is `deploy/restore.sh` with a backup taken *before*
the migration ran — and that restore is useless without `WHARF_MASTER_KEY`.
So: **run `deploy/backup.sh` immediately before deploying any tag whose
migrations are not purely additive.** Check before you deploy:

```bash
cd /opt/wharf
git diff --stat "$(cat deploy/.deployed-tag)".."v1.4.0" -- prisma/migrations/
git diff "$(cat deploy/.deployed-tag)".."v1.4.0" -- prisma/migrations/ \
  | grep -iE '^\+.*(DROP|ALTER COLUMN|RENAME|NOT NULL)'
# any hit → back up first, and treat the release as one-way
```

A failed deploy stops before restarting the services in every case except a
failed health check — build failures and `npm ci` failures leave the previous
release serving. A failed health check *after* migrations have applied is the
dangerous case, and `deploy.sh` says so in its output.

---

### 9. Migrating a live Supabase project onto a WHARF instance

**Goal.** Move a hosted Supabase project (or any reachable Postgres) into an
instance WHARF provisioned, and be able to repeat the pull later without
re-typing anything.

**Before you start.** The sync **replaces everything** in the target instance.
Provision a fresh instance for the migration rather than aiming at one already
serving traffic — the safety snapshot is real, but reverting to it is a manual
`pg_restore`, not a button.

Three things must be true of the **managed server** (not the panel):

```bash
# 1. it can reach the source database
ssh root@<server> "timeout 5 bash -c '</dev/tcp/db.<ref>.supabase.co/5432' && echo reachable"
# 2. curl is installed (only needed for storage objects)
ssh root@<server> "command -v curl"
# 3. it can reach the instance's own public API (only for storage objects)
ssh root@<server> "curl -sSo /dev/null -w '%{http_code}\n' https://<slug>.<INSTANCE_DOMAIN>/rest/v1/"
```

**What to collect from the source project** (Supabase dashboard):

| Field | Where |
|---|---|
| Database host / port / user | **Connect** dialog. A pooler host (`aws-0-<region>.pooler.supabase.com`, port 6543, user `postgres.<ref>`) is normal — copy it verbatim, it is not derivable from the project ref. |
| Database password | The one set for that project; reset it there if unknown. |
| Project URL | Project Settings → Data API. Only needed for storage objects. |
| `service_role` key | Project Settings → API keys. Only needed for storage objects — it is read from the source and stored encrypted. |

**Run it.**

1. Databases → the target instance's ⋯ menu → **Restore / Sync…** →
   **Live database**.
2. Fill in the source, choose what to copy (auth users default on, storage
   objects off), then **Save & test connection**. A green *Connected* means the
   managed server itself reached the source with those exact credentials.
3. Type the instance name and press **Sync from source**.
4. Watch the phases: `connect → dump → snapshot → restore → storage →
   cleanup`. It keeps running if you close the modal; the fleet card streams
   the same job.

**Reading the result.**

- `pg_restore exited with code 1` in the `restore` phase is usually **not** a
  failure. A hosted project references roles that do not exist on a
  self-hosted instance, and pg_restore reports those as errors. Read the lines
  above it; then verify with row counts.
- The `storage` phase prints `DONE ok=N failed=M`. A non-zero `M` leaves the
  object rows in place with no bytes behind them — re-running the sync retries
  exactly those.
- Objects whose names contain a tab or newline are skipped and named in the
  log; move those by hand.

**Role passwords are re-asserted for you.** The loaded data came from a
cluster whose roles had different credentials, so after the restore both
engines reset this instance's six service roles back to its own
`POSTGRES_PASSWORD`. If you ever see `password authentication failed for user
"postgres"` in Studio after a restore, that step did not run (or predates it) —
repair it by hand from the server:

```bash
cd /opt/db-instances/<project>

docker compose -p <project> exec -T db bash -s <<'EOF'
psql -U supabase_admin -d postgres -f /docker-entrypoint-initdb.d/init-scripts/99-roles.sql
psql -U supabase_admin -d postgres -c "ALTER USER postgres WITH PASSWORD '$POSTGRES_PASSWORD'"
EOF

docker compose -p <project> restart
```

Two details that matter:

- **`supabase_admin`, not `postgres`.** In `supabase/postgres` the `postgres`
  role is not a real superuser, and the `supautils` extension marks the service
  roles reserved — running this as `postgres` fails with
  `"supabase_storage_admin" is a reserved role, only superusers can modify it`.
  `roles.sql` gets away with it at first init only because the entrypoint runs
  it before those restrictions apply.
- **The quoted `<<'EOF'`** stops your *host* shell expanding
  `$POSTGRES_PASSWORD` (undefined there); it is expanded inside the container,
  where it is set.

The in-container connection reaches Postgres over its unix socket, which does
not check a password — so this works even when every TCP login is failing.
Verify with a real TCP login afterwards:

```bash
docker compose -p <project> exec -T db bash -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d postgres -c "select 1"'
```

**Verify, then repoint.**

```bash
ssh root@<server> "ls -la /opt/db-instances/<project>/backups/"   # pre-sync-*.backup exists
ssh root@<server> "docker compose -p <project> exec -T db \
  psql -U postgres -d postgres -c 'select count(*) from auth.users'"
```

Then sign in to the new instance's Studio as a migrated user before switching
any application's keys over.

**Re-syncing later** is the same modal — the source is already saved, so it is
type-the-name and go. It is always a full replace, never an incremental diff.

**If it fails.** The instance is left in `error` with the log on its card, and
the pre-sync snapshot is on the server. To revert:

```bash
ssh root@<server>
cd /opt/db-instances/<project>
docker compose -p <project> cp backups/pre-sync-<ts>.backup db:/tmp/revert.backup
docker compose -p <project> exec -T -e PGPASSWORD=<pg password> db \
  pg_restore -U postgres -d postgres --clean --if-exists --no-owner --no-acl /tmp/revert.backup
```

(The Postgres password is in the panel under the instance's **Secrets**.)

### 10. Cloning one live WHARF database into another

Use this for a one-time copy between two registered WHARF instances. Both
must already be running. To create a new copy, provision a destination with
its own name/slug first, then clone into it. The destination keeps its own
URLs, database password, API/JWT keys, settings and server assignment.

1. In **Databases**, open the source's **⋯ → Clone database…** action.
2. Choose the destination, on the same server or another WHARF server.
3. Review the overwrite notice, type the destination's name exactly, and
   select **Overwrite & clone database**.
4. Follow `preflight → dump → transfer → snapshot → restore → verify → cleanup`.
   Closing the modal leaves the job running; reopen its progress from the
   destination card.

**What is copied.** Application schemas and data, Auth data, Storage metadata,
functions, triggers, views, indexes, constraints, sequences, large objects,
owners, grants and RLS policies. The source stays online and is not modified;
the copy represents the source snapshot taken during the dump. Later source
writes are not replicated. Any URLs embedded in application rows or function
bodies remain as stored; review those before using the copy with an app.

**What stays local.** The destination's service credentials, configuration,
database-level settings and runtime schemas (`_realtime`, `_analytics`,
`_supavisor`, `pgbouncer`). PostgreSQL role passwords and memberships are
cluster-wide and are not restored. Uploaded Storage file bytes and other
filesystem volumes are not part of this database clone. Storage rows can
therefore reference files that are absent on the destination; migrate those
files separately before relying on Storage reads.

**Compatibility and capacity.** Database stack image versions must match. The
source cannot contain subscriptions, foreign servers,
scheduled jobs, Vault secrets or pgsodium keys, which depend on the source's
credentials or external systems. Missing destination roles/extensions fail
the restore before the active database is replaced. Allow disk space for the
source dump, destination safety dump, restored staging database and the
existing destination database together. On different servers, archive bytes
stream over SSH/SFTP through the panel with bounded memory; no database port
needs to be exposed.

**During the clone.** Both servers are reserved against other WHARF jobs.
Destination apps continue using their current database during the staged
restore. Their services and database connections pause during final
activation; plan for a brief interruption and prevent application writes
during that cutover. Destination-only schemas and tables are removed by
activating the fresh copy. A destination safety archive is kept at
`<remotePath>/backups/pre-clone-<token>.backup`; the exact path appears in the
job log and audit record. Nothing prunes these archives automatically.

**Verify the result.** Open the destination's Studio, compare representative
tables/row counts, exercise a copied function or query with RLS, and sign in
with a copied Auth account. Use the destination's own connection strings and
API keys. Existing sessions/tokens should not be used as evidence of a good
clone because each instance has its own JWT secret.

**If it fails.** Compatibility or staged-restore failures leave the original
destination database active. A failed activation attempts an automatic swap
back to the original database and restarts the destination's services. The
job still reports failure, even when the destination returns to `running`.
Read its log before retrying. If automatic recovery cannot finish, the
destination becomes `error`; keep it offline, retain the safety archive and
inspect the `wharf_previous_<token>` / `wharf_clone_<token>` database names
shown in the log before any manual cleanup. Do not treat a failed job's
temporary databases as disposable until the active database is identified.

**Developer verification without live servers.**

```bash
WHARF_CLONE_PG_BIN=/path/to/postgresql-17/bin \
  npx tsx scripts/check-clone-postgres.ts
```

Optionally set `WHARF_CLONE_PG_CLIENT_BIN` when `psql`, `pg_dump` and
`pg_restore` are in a separate directory. The test creates two private,
socket-only temporary PostgreSQL clusters, never reads `.env`, and removes
both clusters on completion. It exercises actual dump/restore, schema/data,
RLS, grants/default privileges, triggers/views, sequences, large objects,
target runtime settings/credentials, atomic activation and rollback. It also
checks missing-role and second-rename failure safety. Run it with a compatible
PostgreSQL 17 installation. Managed SSH, Docker and Supabase service health
require separate deployment smoke checks.

Keep these PostgreSQL-specific regressions covered: a fresh `template0`
database already has `public`, and a normal dump may omit its creation, so
staging must preserve it. A filtered `pg_restore --schema` does not recreate
the schema itself from a full archive; runtime preservation uses a separate
schema-selected `pg_dump` archive restored in full. The executable test uses
the same SQL builders/restore flags as the clone engine.

---

### 11. An instance's status changed on its own

The panel checks every server once a minute (`HEALTH_CHECK_INTERVAL_MS`,
default 60000, `0` disables) with one read-only `docker ps -a` over SSH,
and corrects instances whose stored status no longer matches the containers:

| What the server shows | Status becomes |
|---|---|
| every service running | `running` |
| every container stopped | `stopped` — Start brings it back |
| some services exited, crash-looping, unhealthy or missing | `error` — Retry runs the idempotent `up -d` |
| server unreachable (running instances only) | `error` |

A change needs two consecutive checks to agree (about 2 minutes), so a
container mid-restart never flips it. The reason is the instance's last log
line (`Health check at …: kong exited (code 137)`) and an
`instance.health.status-change` audit row. The check never touches
instances mid-job, servers whose lock is held, or an `error` left by a failed
provision/restore/clone — and it switches its own `error` back to `running`
once the stack is healthy again.

## Quick reference

### Environment variables — and what breaks without each

Set in `/etc/wharf/.env` (mode 0600/0640, never in the repo). Both services
read the same file.

| Variable | Missing / wrong → |
|---|---|
| `DATABASE_URL` | Panel and gateway fail every request. Gateway refuses to start (`refusing to start — DATABASE_URL is not set`). Must be the **pooled** 6543 string with `pgbouncer=true`. |
| `DIRECT_URL` | `prisma migrate deploy`, `backup.sh` and `restore.sh` all fail. The panel keeps running — so this breaks silently until a deploy or a backup. Must be the **direct** 5432 string. |
| `NEXTAUTH_SECRET` | No one can log in; sessions do not verify. Gateway refuses to start. If panel and gateway ever hold *different* values, the terminal refuses every upgrade while the panel looks fine. |
| `WHARF_MASTER_KEY` | Gateway refuses to start. Panel starts, then fails every decrypt: no SSH, no secret reveal, no provisioning. Must decode to exactly 32 bytes. **Losing it is unrecoverable** — the backup is ciphertext. |
| `NEXTAUTH_URL` | Auth callbacks redirect to the wrong host; login loops. |
| `PANEL_URL` | Traefik's forwardAuth calls the wrong address → every Studio request 401s. Must be `https://` (boot warning otherwise) and under `COOKIE_DOMAIN`. |
| `COOKIE_DOMAIN` | Empty in production → host-only session cookie → the browser never sends it to `studio-*.<domain>` → Studio bounces to login forever, with nothing in any log. Empty is *correct* for localhost. |
| `INSTANCE_DOMAIN` | Provisioning refuses to start. Must be the apex whose wildcard points at the database server, and must share an apex with `COOKIE_DOMAIN`. Security middleware also reads it for Studio's CSP allowance. |
| `GATEWAY_PORT` | Defaults to 3001. Change it and you must change the proxy config too (`deploy/Caddyfile` / `nginx.conf.example`) and `deploy.sh`'s health URL. |
| `NEXT_PUBLIC_GATEWAY_WS_URL` | The browser cannot open a terminal. In production this is `wss://panel.<domain>` — the proxy routes `/ws/*` to the gateway. This value is inlined into the client bundle at build time. |
| `GATEWAY_WS_URL` | Optional server-side override for the CSP gateway allowance. If unset, CSP falls back to `NEXT_PUBLIC_GATEWAY_WS_URL`; it does not change the endpoint compiled into the browser bundle. |
| `LETSENCRYPT_EMAIL` | Traefik registers with no contact address; no expiry warnings. Changing it needs a **bootstrap re-run** per server to reach `traefik.yml`. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Only read by `npm run db:seed`. Leave the placeholder and you seed a known-password admin. |
| `SEED_DEMO` | `1` seeds demo fixtures. Development only. |

#### Build-time vs restart-time

Most variables take effect on `systemctl restart`. `NEXT_PUBLIC_GATEWAY_WS_URL`
is compiled into the browser bundle and requires a **rebuild** when changed.
Security middleware builds CSP per request: `INSTANCE_DOMAIN` controls the Studio
iframe allowance, and `GATEWAY_WS_URL` can override the server-side gateway
allowance. Changing those server-only settings requires a restart.

Inspect the headers from the running panel rather than the build manifest:

```bash
curl -sI http://127.0.0.1:3000/login | grep -i content-security-policy
# …; frame-src 'self' https://*.wharf.example.com; connect-src 'self' wss://panel.wharf.example.com
```

`deploy/deploy.sh` sources `/etc/wharf/.env` before building. Keep the browser
endpoint and runtime CSP gateway allowance consistent, then verify a terminal
and Studio session after deploying. Sanitize domain names before sharing the
header output publicly.

Related: **the reverse proxy must not set security headers.** The app owns
CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and
`nosniff`. Adding a CSP in Caddy overwrites the app's; adding one in nginx
gets both enforced as an intersection. Either way the Studio iframe dies and
the cause is invisible server-side. `deploy/Caddyfile` and
`deploy/nginx.conf.example` both say so at the point of temptation.

#### Boot-time validation

`lib/config-check.ts` (panel, warnings only — it never blocks startup) and
`gateway/src/index.ts` (gateway, hard exit 1).

```bash
journalctl -u wharf-panel   --since today | grep -A10 'configuration problems'
journalctl -u wharf-gateway --since today | grep -A10 'refusing to start'
```

### Health endpoints

| Endpoint | Expected |
|---|---|
| `http://127.0.0.1:3000/api/healthz` | `{"ok":true,"service":"wharf-panel"}` |
| `http://127.0.0.1:3001/healthz` | `{"ok":true,"uptimeSec":N}` |

Both are unauthenticated and loopback-only in the shipped config (the proxy
does not expose `/healthz`; `/api/healthz` is reachable through it). Neither
touches the database — a healthy `/healthz` says "the process is alive", not
"the database is reachable". For that, `npm run db:check`.

### Logs

Everything is in journald. There are no application log files.

```bash
journalctl -u wharf-panel   -f                 # follow the panel
journalctl -u wharf-gateway -f                 # follow the gateway
journalctl -u wharf-panel   -n 200 --no-pager
journalctl -u wharf-panel   -p err --since "1 hour ago"
journalctl -u wharf-panel   --since "1 hour ago" --until "now"
journalctl -u caddy -f                         # TLS / proxy issues
journalctl --disk-usage                        # journald growth
```

Traefik and Supabase logs live on the **managed** servers:

```bash
ssh root@<database-server>
docker logs -f $(docker ps -qf name=traefik)
docker compose -p sb_xxxx logs -f --tail 100
```

By design, terminal sessions are audited as **metadata only** (user, server,
duration) — there are no keystroke transcripts anywhere.

### Cron jobs

One, in root's crontab:

```cron
# WHARF panel database backup — nightly 03:15, 14-day retention
15 3 * * * /opt/wharf/deploy/backup.sh >> /var/log/wharf-backup.log 2>&1
```

Optional second entry for an offsite copy (or set the variable in root's
environment):

```cron
15 3 * * * WHARF_BACKUP_RCLONE_REMOTE=b2:my-bucket/wharf /opt/wharf/deploy/backup.sh >> /var/log/wharf-backup.log 2>&1
```

Everything else is timer-driven by other packages: Caddy renews certificates
itself; certbot installs `certbot.timer`. Check them with
`systemctl list-timers`.

**Nothing prunes the panel's soft-deleted instance rows or audit log
automatically.** Both grow forever. See [Gaps](#gaps-an-operator-still-has-to-work-around).

### Service control

```bash
systemctl status  wharf-panel wharf-gateway --no-pager
systemctl restart wharf-panel wharf-gateway     # after editing /etc/wharf/.env
systemctl stop    wharf-panel wharf-gateway     # before a restore or key rotation
systemctl reset-failed wharf-gateway            # after fixing a start-loop
systemd-analyze verify /etc/systemd/system/wharf-panel.service
```

---

## Known operational truths

Things that are true, non-obvious, and change what you do in a crisis.

1. **Instances keep running when the panel is down.** WHARF is a control
   plane. Live traffic to hosted sites and to provisioned Supabase APIs goes
   through Traefik on each managed server and never touches the panel. A panel
   outage means nobody can *manage* anything; it does not mean anything is
   *down*. Do not escalate a panel restart as a customer-facing incident.

2. **The database dump is ciphertext without `WHARF_MASTER_KEY`.** Every SSH
   password, SSH private key, Supabase anon/service_role key, JWT secret and
   Postgres password is AES-256-GCM sealed with it. The key lives only in
   `/etc/wharf/.env`. **Dump + key = recovery. Dump alone = a read-only museum
   of your fleet.** Back them up separately, to different places, and drill
   restoring them together. This is the single most important operational fact
   in the product.

3. **Stop preserves data. Remove destroys it.** *Stop* runs
   `docker compose stop`: volumes intact, Traefik routers vanish so the
   subdomains go quiet, fully reversible with Start. *Remove permanently* runs
   `docker compose down -v` and deletes the remote path — **volume data is
   gone and no backup of WHARF's covers it**; WHARF backs up its own metadata
   database, not the databases it provisions. The metadata row lingers as a
   soft delete, which fools people into thinking the data is recoverable. It
   is not. Remove is admin-only with a type-the-name confirmation for exactly
   this reason.

4. **The audit log is insert-only at the database level.** A Postgres trigger
   raises on `UPDATE` and `DELETE` (migration `20260724000002_audit_immutable`);
   the Prisma layer never exposes mutation of it either. You cannot tidy it,
   redact it, or fix a typo in it — and neither can an attacker who reaches
   the panel's database credentials. It survives a `pg_dump`/`pg_restore`
   round trip, trigger included.

5. **Preparation is lazy, and preflight runs before any mutation.**
   Registering a server does nothing to it. The first provision onto a server
   prepares it (Docker, the `traefik` network, Traefik, firewall) as its
   opening phase. A server that fails preflight is left **completely
   untouched** — no partial install to clean up.

6. **A stuck job heals on the next panel boot, not on a timer.** The stale-job
   sweep runs once per process start (`instrumentation.ts`), not periodically.
   If a row has been `provisioning` for hours and the panel has not restarted,
   restarting it is the fix.

7. **Retry is always safe; nothing retries by itself.** The provision pipeline
   is idempotent (`docker compose up -d` re-converges). WHARF never silently
   retries a failed job — a human chooses Retry or Remove, every time.

8. **Orphans are running databases with real data.** `docker compose down -v`
   on one is as destructive as Remove. Resolution is manual and always will be.

9. **The panel talks to servers over SSH only.** No Docker socket is exposed,
   no Docker TCP port. One trust boundary, one credential store. Anyone with
   the master key and database access has the fleet — which is why the key
   does not live in the repo, in the database, or in the backup.

10. **Two variables are compile-time, and both fail silently in the browser.**
    `INSTANCE_DOMAIN` and `NEXT_PUBLIC_GATEWAY_WS_URL` are baked into the
    Content-Security-Policy at `next build` time. Edit them in
    `/etc/wharf/.env`, restart, and nothing changes — the Manage iframe stays
    blank and the terminal stays dead, with a clean `journalctl`. A rebuild is
    the fix. See "Build-time vs restart-time" above.

11. **A blank Manage frame is almost always CSP, not SSO.** The two failure
    modes look identical from the user's chair. Tell them apart in ten
    seconds: a **CSP** failure logs a `Refused to frame` error in the browser
    console and leaves the panel's journal silent; an **SSO** failure shows a
    redirect to the login page inside the frame, and Traefik on the database
    server logs the forwardAuth 401. Check the browser console first.

---

## Gaps an operator still has to work around

Honest list of things this runbook cannot solve with a supported command.

1. **Clearing a changed host key has no UI or API.** `serverUpdateSchema` does
   not accept `hostKeyFingerprint`, and no route resets it — despite
   `lib/ssh.ts` documenting recovery as "a deliberate admin action (clearing
   the stored fingerprint)". Playbook 1 uses direct SQL, which means the act
   is **not audited**. Worth a small admin-only endpoint
   (`DELETE /api/servers/:id/host-key`) that writes an audit row.

2. **No "adopt orphan" flow.** After a database restore, instances created
   since the dump are detected but cannot be re-attached to the panel. The
   only paths are leave-and-document or destroy-and-re-provision.

3. **No retention on soft-deleted instances or the audit log.** Architecture
   §4.3 mentions a "hard purge after grace period"; nothing schedules it. Both
   tables grow without bound. Nothing breaks soon, but plan for it.

4. **No monitoring or alerting is shipped.** `/api/healthz` and `/healthz`
   exist; nothing polls them. Point your own uptime check at
   `https://panel.<domain>/api/healthz`. Nothing alerts on a failed
   `backup.sh` either — the cron output goes to a log file nobody reads. Wire
   the exit code into your alerting.

5. **`deploy/backup.sh` covers the panel database only.** Provisioned Supabase
   instances' own data is **not** backed up by anything in WHARF. If those
   databases hold something that matters, they need their own backup story on
   the managed server. (The `pre-restore-*`/`pre-sync-*`/`pre-clone-*` snapshots
   left by restore, sync or clone jobs are not a backup schedule, and
   nothing prunes them — watch `/opt/db-instances/*/backups/` for disk.)

9. **A sync is always a full replace, never an incremental diff**, and nothing
   schedules one. Re-running it re-dumps the whole source and overwrites the
   instance again. If you need continuous replication rather than repeatable
   migration, this is not that — use logical replication directly between the
   two databases.

6. **No blue/green or canary.** `deploy.sh` restarts in place; there are a few
   seconds of downtime per deploy, and no automatic revert on a failed health
   check (it fails loudly and leaves you to decide, precisely because the
   migrations it just applied are not reversible).

7. **The Studio iframe has two independent ways to fail, and one is
   deployment-dependent.** The panel's own side is handled: security middleware allows
   `frame-src https://*.INSTANCE_DOMAIN`. The *other* side — Studio/Kong
   emitting their own `X-Frame-Options` / `frame-ancestors` that refuse to be
   framed — is anticipated by architecture §4.5, which prescribes a Traefik
   response-header-strip middleware on the studio router, but
   `templates/traefik/dynamic/` ships no such middleware today. If Manage
   opens a blank frame and the panel's CSP is correct, this is where to look,
   and you will be writing that middleware yourself. The documented fallback
   is "open in new tab" (still zero-login).

8. **`deploy.sh` ignores untracked files when checking for a dirty checkout.** It
   runs `git status --porcelain --untracked-files=no` so its own output file
   does not make the next run refuse. The side effect: other stray untracked
   files in the tree are also not flagged. Use a dedicated deployment checkout
   and keep local files outside it.
