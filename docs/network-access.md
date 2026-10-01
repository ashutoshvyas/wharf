# Database network access

WHARF administrators can manage each database's PostgreSQL access from
**Databases → instance actions → Network access**, including stopped instances,
or from **Manage → Network access** for a running instance. Operators and viewers
can inspect settings; only administrators can change them.

Choose **Allow selected addresses**, **Allow all addresses**, or **Block all
database connections**. Enter one public client IP or CIDR range per line.
An address outside a selected-address list is denied. Removing an address
revokes its access. IPv4 and IPv6 ranges are accepted. Database credentials and
the instance's SSL policy still apply. These settings cover the shared pooler's
session port **5432** and transaction port **6543**, not the Supabase HTTPS API,
Auth, Storage, or Studio.

## Existing servers

Deploy the application and the `20261001120000_database_network_access` Prisma
migration together. Existing rows are initialized to **Allow all addresses**;
the migration does not change any live firewall. New databases created by this
version use the same allow-all default, and API and Studio remain available.

On a server with existing source restrictions in `DOCKER-USER`, perform the
one-time **Set up network access** step in an instance's Network access page:

1. Review the databases on the server. They use Allow all unless you have
   already saved an explicit policy.
2. Optionally enter the source IPs/ranges those legacy databases should allow. For
   example, an existing `-s 198.51.100.10/32 --dport 5432 -j ACCEPT` rule suggests
   including `198.51.100.10` if that application should retain access. That excerpt
   alone is not a complete firewall policy: review other permitted sources too.
   Include the panel's own outbound IP if its metadata database is hosted here.
3. Leave the list blank to keep Allow all, type the server name, and choose
   **Enable server network access**.
4. Add/remove addresses independently on each database afterward.

The optional baseline is applied only to databases with no explicit policy.
Previously saved policies, including Block all, are retained. There is no
automatic translation of arbitrary iptables/nftables programs into tenant
allowlists. Setup refuses unknown/orphaned pooler tenants, busy servers, and
unverified policies before installing a shared host exception. Unknown tenants
must be accounted for by an administrator; WHARF does not delete them during setup.

Changing policies disconnects that database's current pooler clients so they
reconnect under the new rules. Initial server setup can reconnect clients for
all its databases. Schedule it accordingly.

## Enforcement and persistence

Instances share one Supavisor service on each host. Host-port rules alone cannot
distinguish the requested tenant. The enforcement therefore has two parts:

- Per-instance policies use Supavisor 2.9.5's tenant `allow_list`. Allow all sends
  both `0.0.0.0/0` and `::/0`. Block all removes the tenant from the pooler and
  terminates its pools, without stopping its Supabase services or deleting data.
- After verifying every registered tenant's policy, WHARF installs its own
  `WHARF-POOLER` chain and a leading jump in `DOCKER-USER`. Only packets addressed
  to the actual WHARF pooler container on 5432/6543, whose original published
  destination port matches, are accepted by this exception, together with the
  matching replies from that pooler. Existing rules (including manually created
  allow/deny rules) remain in place; WHARF does not flush or delete them. The
  leading WHARF jump is evaluated first for this pooler's traffic, so an older
  source-specific rule can remain visible while no longer being the effective
  per-database control. Other containers,
  the pooler admin API, SSH, HTTP, and HTTPS are outside this exception.

The helper and unit files are in `templates/pooler/`. Installation writes
`/opt/wharf/pooler/apply-network-firewall.sh` plus
`wharf-pooler-firewall.service` and `.timer` under `/etc/systemd/system/`.
The timer runs after boot and every 30 seconds to reconcile changed container
addresses and restored firewall rules. A restart/container replacement can cause
a short connection interruption until the next reconciliation. Only WHARF's
chain is atomically replaced; the complete Docker ruleset is never flushed or
saved. Missing poolers cause stale WHARF destination rules to be cleared.

Requires systemd, Docker's iptables backend (iptables-nft is supported),
`iptables-restore`, and `flock`, with the same root-capable SSH account used for
provisioning. Native Docker nftables without `DOCKER-USER` is rejected. This
does not configure a cloud-provider security group or bypass earlier firewall
hooks. IPv6 client restrictions require a path that preserves the original
client address; Docker's IPv6-to-IPv4 userland proxy may hide it.

Saved policies live in `db_instances.network_access`; apply time/error are
stored separately. A save is not shown as active until the pooler's network
metadata has been read back and verified. A failed operation leaves the desired
policy saved and visibly pending for retry; the previous runtime policy may
remain active. The per-server lock serializes setup, edits, provisioning, TLS
changes, and lifecycle operations. Provisioning retries and SSL changes preserve
the saved network policy. Sensitive SSH/pooler error text is not exposed to the
client or logs by the network-access operations.

Keep WHARF as the owner of this shared pooler's tenant registration after setup.
Out-of-band tenant creation can bypass its policy validation. Do not roll back
to a WHARF version that ignores network policies while leaving the managed
firewall exception enabled.

## Validation

Unit coverage includes malformed IPs/ranges, role gates, tenant isolation,
pending failures, legacy adoption, unknown tenant rejection, and new-instance
defaults. The real firewall helper runs in tests against simulated Docker and
iptables executables to check destination/port scope, repeated runs, changed
container IPs, and failure handling. Browser coverage exercises validation,
reviewed server setup, read-only roles, and failed application feedback.

Before enabling this on a production server, verify on a staging host with two
databases and two client source addresses: each allowed source connects only to
its permitted tenant on both ports, removed/blocked clients disconnect, other
containers' access remains unchanged, and policies survive a Docker/server
restart. The repository checks cannot prove the live host's packet path.
