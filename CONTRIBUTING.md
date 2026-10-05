# Contributing to WHARF

WHARF is developed by INITQUBE. Contributions are welcome through issues and
pull requests. Report vulnerabilities privately as described in `SECURITY.md`.

## Local development

Use Node.js 22 and npm. Copy `.env.example` to `.env`, configure your own
database, and generate fresh authentication and encryption keys. Choose a
unique administrator passphrase. The template contains no working credentials.

```sh
npm ci
npx prisma generate
npm run db:check
npm run db:deploy
npm run db:seed
npm run dev
```

Run migrations only against a database you intend to change; both
`DATABASE_URL` and `DIRECT_URL` must identify that database. End-to-end tests
require a disposable local PostgreSQL database and reject remote URLs.

## Before opening a pull request

```sh
npm run lint
npm run typecheck
npm run typecheck -w gateway
npm test
npm run check:secrets
npm run check:credentials
```

`check:credentials` requires Gitleaks v8.30.1 or a compatible newer version.
To check staged changes automatically, install the `pre-commit` tool and run:

```sh
pre-commit install
```

Use reserved example domains and TEST-NET addresses for fixtures. Do not commit
environment files, private keys, backups, real account identities, or internal
deployment logs. Scanner exceptions must match an exact synthetic fixture and
its specific path; do not disable scanning for an entire test directory.

If repository history has been rewritten, use a fresh clone before contributing.
Do not merge or push branches from an older clone: that can restore removed
data. Reapply only the changes you need onto the current clean history.

## License and attribution

Contributions are submitted under the repository's Apache-2.0 license unless
otherwise agreed before submission. Keep the copyright and attribution notices
in `NOTICE`, including **“WHARF is developed by INITQUBE.”**, when redistributing
WHARF or derivative works as required by the license. Preserve applicable
third-party licenses and notices too.
