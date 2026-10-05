# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub's **Report a vulnerability**
option on the repository's Security tab:

https://github.com/ashutoshvyas/wharf/security/advisories/new

Include the affected version, a description, and reproducible steps using
synthetic credentials and data. Do not post credentials, private hosts, or
customer data in public issues, pull requests, or logs.

## Supported versions

Security fixes are maintained on the current `main` branch. Check the release
notes before deploying an older version.

## Operating WHARF

WHARF can access SSH credentials, database passwords, and administrator
functions. Restrict panel access, use TLS and a strong administrator
passphrase, and store the encryption master key separately from database
backups. Never reuse test fixtures as real credentials.

GitHub Actions perform verification only; the repository has no automatic
server deployment workflow or stored VPS deployment secrets. Deploy manually
with your own private runtime configuration.

See `docs/security-review.md` for architecture boundaries and known limitations,
and `docs/runbook.md` for backup and key-rotation procedures. If a real secret
is exposed, revoke or rotate it before cleaning up its historical copies.
