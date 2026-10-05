# Third-party notices

WHARF's original code and documentation are Copyright 2026 INITQUBE and
licensed under Apache-2.0. Third-party material retains its original license.

## Vendored Supabase deployment files

The compose, environment, auxiliary configuration, and database initialization
files under `templates/supabase/` originate from
[`supabase/supabase`](https://github.com/supabase/supabase) at commit
`9cf6ae1f6779efcef70dcc94d64e5d8e1cee8304`.

Copyright 2024 Supabase. Licensed under the Apache License, Version 2.0.
The upstream license is included in `templates/supabase/LICENSE`.
WHARF modifies these files for per-instance rendering, authentication,
network isolation, and optional services. The modifications and upgrade
process are documented in `templates/supabase/VERSIONS.md`.

## Package dependencies and container images

Dependencies installed through npm and images referenced by deployment
templates are distributed by their respective publishers under their own
licenses. Their use here does not change those licenses. Preserve relevant
licenses and notices when redistributing dependency code or image contents.
