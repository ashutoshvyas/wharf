# WHARF — Design Document

**Design system:** WHARF by INITQUBE.
**Implementation:** `app/globals.css` (tokens) and `components/ui/` (components).

---

## 1. Design direction

WHARF is an operator's tool: dense information, real consequences (a wrong click can delete a database), long-running operations that must feel observable. Its palette, type, spacing, radius and elevation support a consistent control panel:

- **Cobalt is structure and action.** Primary buttons, active nav, links, focus rings.
- **Coral is scarce and meaningful.** In a control panel, "≤10% of any surface" becomes: coral marks *the live/active thing* — a provisioning pulse, the active nav dot, an attention state. Never decoration.
- **Neutrals do the layout.** White cards on `neutral-50` canvas, `neutral-200` borders, ink (`#152C6B`) for headings.
- **JetBrains Mono identifies machine values:** hostnames, slugs, subdomains, paths, keys, logs and the terminal. If a value would be copy-pasted into a shell, it's mono.
- **Semantic colors carry state.** Status is the most important data in the app; success/warning/danger/info get systematic use (badges, log lines, alerts) instead of occasional use.

Danger is its own register: destructive affordances use `danger` red exclusively — coral is *never* used for destructive actions, so "spark" and "destroy" can't be confused.

---

## 2. Design tokens

Defined in WHARF's `app/globals.css` using Tailwind v4 `@theme`.

### 2.1 Color

| Token | Value | WHARF usage |
|---|---|---|
| `cobalt-500` | `#2B54C7` | Primary actions, active nav, links |
| `cobalt-600/700` | `#2547AD` / `#1F3B8F` | Hover/pressed |
| `cobalt-50/100` | `#EEF2FD` / `#DBE3FB` | Selected rows, info chips, ghost hover |
| `ink` (`cobalt-900`) | `#152C6B` | Headings, body-strong, default foreground |
| `coral-500` | `#EC6B45` | Active pulse, provisioning spinner, selection highlight, ≤10% rule |
| `coral-600` | `#D4562F` | Coral hover |
| `neutral-0…800` | `#FFFFFF…#1F2530` | Canvas `50`, borders `200`, secondary text `500`, terminal chrome `800` |
| `success` | `#2E9E6B` | `running` status, success log lines, healthy checks |
| `warning` | `#E7A63C` | `stopped`, `provisioning` (with coral pulse), pending states |
| `danger` | `#D8493C` | `error` status, destructive buttons, failed log lines |
| `info` | `#2B7FC7` | Informational alerts, hints |

Full cobalt/coral/neutral scales (50–900 / 50–700 / 0–800) exactly as in `globals.css`.

**Dark surfaces:** the terminal and log viewers are the app's only dark regions — `neutral-800` chrome, near-black `#0D1117`-style screen, on-dark component variants (`bg-white/10`, `border-white/15`) from the existing kit. The rest of the panel stays light; no app-wide dark mode in v1.

### 2.2 Typography

Figtree (400–800) + JetBrains Mono, per brand. Panel scale (control-panel register — one step denser than the marketing scale):

| Style | Spec | Usage |
|---|---|---|
| Page title | Figtree 28/700, tracking −0.02em | One per screen ("Databases") |
| Section title | Figtree 20/600 | Card groups, modal titles |
| Card title | Figtree 16/600 | Server/instance cards |
| Body | Figtree 14/400, lh 1.6 | Default UI text |
| Small | Figtree 13/400, `neutral-500` | Descriptions, timestamps |
| Label | JetBrains Mono 11/500, uppercase, tracking 0.22em (`.label-track`) | Section labels, table headers, form labels |
| Mono value | JetBrains Mono 13/400 | Hosts, slugs, paths, subdomains, keys |
| Terminal / logs | JetBrains Mono 13/400, lh 1.5 | xterm.js + log streams |

### 2.3 Spacing, radius, elevation

- **Spacing:** base-4 rhythm. Panel defaults: card padding 20–24, gaps 16, table cell 12×16, page gutter 24 (32 on ≥1280px).
- **Radius:** `6 / 12 / 16 / full` — inputs & badges-inner 6, buttons & cards 12, modals & terminal frame 16, pills & avatars full.
- **Elevation:** brand shadows verbatim (`shadow-sm` resting cards, `shadow-md` hover/popovers, `shadow-lg` modals, `shadow-glow` for the single active/emphasized element — e.g. the instance currently provisioning).
- **Iconography:** Lucide line icons, 1.75px stroke, 24px grid, square terminals. Coral only on a single active/emphasis state.
- **Motion:** 200ms ease transitions; `hover:-translate-y-0.5` lift on buttons/cards; `animate-spark` (coral pulse) for in-flight operations; full `prefers-reduced-motion` kill-switch, all carried from `globals.css`.

---

## 3. Application shell

```
┌────────────┬──────────────────────────────────────────────┐
│  WHARF     │  Page title                    [user ▾ role] │
│  wordmark  ├──────────────────────────────────────────────┤
│            │                                              │
│  ● Servers │   Content area                               │
│  ○ Websites│   max-w-none, px-6 (px-8 ≥1280)              │
│  ○ Databases                                              │
│            │                                              │
│  ────────  │                                              │
│  Audit log │                                              │
│  Users ᵃ   │                                              │
└────────────┴──────────────────────────────────────────────┘
```

- **Sidebar** (240px, `neutral-0`, right border `neutral-200`): wordmark top (Figtree 700, "wharf" lowercase mirroring "initqube"; optional Qube-derived mark with one coral quadrant). Nav items: Figtree 14/500; active = `cobalt-50` bg, `cobalt-700` text, 3px coral left-edge indicator (the coral spark = "where you are"). `Users` admin-only; `Audit log` viewer+.
- **Topbar** (56px): page title left; right side = user chip with role badge (`admin` cobalt / `operator` neutral / `viewer` neutral badge) and sign-out menu.
- **Content canvas:** `neutral-50` background; content in white cards `radius-12` + `shadow-sm`.
- Collapses to icon rail <1024px; this is a desktop tool — mobile gets a readable single column, no feature parity promises.

---

## 4. Component kit

Base: existing `ui.tsx` (Button/ButtonLink, Badge, SectionLabel, Container) + shadcn/ui primitives (Dialog, DropdownMenu, Tabs, Tooltip, Toast) restyled with the tokens above.

### 4.1 Carried over as-is
- **Button** — variants `primary` (cobalt, glow shadow), `accent` (coral — reserved for the one "spark" CTA per screen, e.g. **New instance**), `secondary` (white/border), `ghost`, `onDark` (terminal toolbar); sizes md/lg; same hover-lift and focus ring (`ring-cobalt-400`).
- **Badge** — cobalt / coral / neutral / onDark pill.
- **SectionLabel** — coral tracked-mono label with dash.

### 4.2 New variants & components for WHARF

**Danger button** (new variant): `bg-danger text-white hover:bg-[#c03e33]`, same geometry as primary. Used only for Remove/Delete. Never coral.

**StatusBadge** — the workhorse. Dot + tracked-mono label in a tinted pill:

| Status | Dot / tint |
|---|---|
| `running` | success dot, `success/10` bg |
| `provisioning` | coral dot with `animate-spark` pulse, `coral-50` bg |
| `stopped` | warning dot, `warning/10` bg |
| `error` | danger dot, `danger/10` bg |
| `removing` | danger dot pulsing, `danger/10` bg |
| server `bootstrapped` / `not bootstrapped` / `unreachable` | success / neutral / danger |

**MonoField** — labeled mono value with copy-to-clipboard button and optional reveal toggle (eye icon) for secrets. Reveal is per-field, auto-hides after 30s, and (per architecture) the fetch is audited. Used for: host, subdomains, paths, anon/service_role keys, PG password.

**Card** — white, `radius-12`, `border-neutral-200`, `shadow-sm`, `hover:shadow-md hover:-translate-y-0.5` when clickable. Entity cards (server, instance) follow: title row (name + StatusBadge) / mono meta lines / action row.

**DataTable** — brand table style: mono tracked column headers (11/500 uppercase, `neutral-500`), 14px Figtree cells, mono for technical columns, row hover `neutral-50`, selected `cobalt-50`. Used for websites list, audit log, instance list (table view).

**LogStream** — dark panel (`neutral-800` chrome bar + near-black body, `radius-16`), mono 13, auto-scroll with pin-to-bottom toggle. Line prefixes: `✓` success-green, `✗` danger-red, `›` neutral running-step. Chrome bar shows operation name + StatusBadge + elapsed time. Used for provisioning, bootstrap, teardown streams (SSE).

**Terminal** — xterm.js inside the same dark frame as LogStream; chrome bar = server name (mono), connection StatusBadge, duration, onDark ghost buttons (font size, disconnect). Theme: `#0D1117` bg, `neutral-100` fg, cobalt-300 cursor, coral selection (mirrors brand `::selection`).

**Alert** — info/success/warning/danger; tinted bg (`{color}/8`), 3px left border in the semantic color, icon + title (Figtree 600) + body. E.g. the wildcard-DNS prerequisite callout on the server bootstrap panel.

**ConfirmModal (destructive)** — `radius-16`, `shadow-lg`. Danger icon top, plain-language consequence copy (the spec's requirement: *"the data is gone once volumes are removed"* stated verbatim-level explicitly), then a mono type-to-confirm input requiring the instance name; Danger button stays disabled until it matches exactly. Cancel is the `secondary` (visually dominant-safe) option.

**EmptyState** — centered in card: line icon, one sentence, one action button. Each module gets one ("No servers yet — register your first server.").

**Form patterns** — labels use `.label-track`; inputs `radius-6`, `border-neutral-200`, focus `ring-2 ring-cobalt-400`; inline validation in `danger` with 13px message; technical inputs (host, slug, path) render in mono as the user types.

---

## 5. Screen-by-screen

### 5.1 Login
Centered card on `neutral-50` with faint `bg-grid-ink` backdrop (brand utility). Wordmark, email + password, primary button. Error alert on bad credentials. Nothing else — no marketing.

### 5.2 Servers — list
Grid of Server cards (2–3 col). Card: name + bootstrap StatusBadge / mono `user@host:port` / tag pills (neutral badges) / counts ("3 websites · 2 databases") / actions: **Terminal** (secondary), **Open panel ↗** (ghost, only if `linked_panel_url`), overflow menu (Edit, Delete-admin). Topbar action: **Add server** (primary). No bootstrap affordance lives here — servers are prepared for database hosting implicitly, on first provision (architecture §4.1).

### 5.3 Server — register/edit
Modal (or side sheet) form: name, host, port, user; auth method as a two-option segmented control — *Private key (recommended)* / *Password*. Choosing key offers **Generate keypair**: panel shows the public key once in a MonoField with copy + an info Alert ("paste into `~/.ssh/authorized_keys`"). Optional linked panel URL, tags.

### 5.4 Server — detail
Header: name, StatusBadge, host MonoField. Tabs (brand tab style — active tab `cobalt-600` text + 2px cobalt underline; coral dot only if a tab has attention state):
- **Overview** — meta, tags, and a **Database hosting** card that is *informational by default*: a server that hosts no databases shows only "Not a database host — prepared automatically when the first database instance is provisioned onto it", since most servers exist for websites alone. A server that already hosts databases shows its prepared state, the wildcard-DNS record it needs (`*.<domain> → host`), and an admin-only **Re-run setup** maintenance action (idempotent; re-uploads Traefik config so a changed panel URL or LE email reaches the server) with LogStream when running.
- **Hosted** — the per-server "one glance" view: websites + db instances in one DataTable, type-iconed rows linking into their modules.
- **Terminal** — full-height Terminal component. Viewer role sees a locked EmptyState instead.

### 5.5 Websites
DataTable: Domain (mono, external-link icon) · Server (link) · Path (mono, truncate-middle) · Database (instance link or "—") · Credential (label + reveal MonoField in row expansion) · actions. **Add website** primary button → modal form; `credential_label` is an editable text field defaulting to "Admin login". Row expansion shows notes + full credential block.

### 5.6 Databases — fleet dashboard
The signature screen. Card grid (table toggle available):

```
┌───────────────────────────────────┐
│ clienta-prod          ● RUNNING   │
│ sb_4f2a · vps-01                  │
│ clienta.domain.com            ⧉  │
│ studio-clienta.domain.com     ⧉  │
│ created 12 Jun 2026               │
│ [ Manage ]  [ Stop ]  [ ⋯ ]      │
└───────────────────────────────────┘
```

- **Manage** = primary cobalt (the "switch to" affordance — one instance's Manage is the emphasized action). **Stop/Start** secondary. Overflow: Secrets (reveal panel), Logs, **Remove permanently** (danger, admin-only — hidden entirely for others, not disabled).
- A provisioning card carries `shadow-glow` + coral pulsing badge + inline collapsed LogStream (expandable) streaming SSE.
- An `error` card shows a danger Alert strip with the log-tail link + **Retry** / **Remove**.
- Topbar action: **New instance** (accent coral — this is the screen's spark CTA).

### 5.7 New instance — provisioning flow
Modal: Server select — **all reachable servers are selectable**; a server that is not yet a database host carries an inline note ("will be prepared first — adds ~2 min") rather than being disabled, because preparation is now part of provisioning (architecture §4.1). Choosing such a server also surfaces the wildcard-DNS requirement for that host, since it is the moment the record starts to matter · name · auto-suggested slug in a mono input with live subdomain preview underneath (`{slug}.domain.com` / `studio-{slug}.domain.com`, updating per keystroke) · uniqueness/charset validation inline. Submit → modal transitions to a full LogStream view with step checklist (Prepare server *(shown only when needed)* → Generate secrets → Render compose → Upload → Start containers → Health checks) — each step gets `✓`/`✗`/pulsing `›`. The prepare phase expands into its own sub-steps (preflight → Docker → network → Traefik config → Traefik → firewall) so a first-time provision reads as one continuous operation. Closeable at any time; progress continues, card on the fleet grid stays live.

### 5.8 Manage (Studio iframe)
Panel shell persists (sidebar + slim topbar strip: instance name, StatusBadge, **Open in new tab ↗**, back-to-fleet). Studio fills the remaining viewport in an iframe, `radius-0`, no chrome — feels like one app. If frame-blocking is detected: an EmptyState card with the same "Open in new tab" primary action.

### 5.9 Remove flow
Overflow → ConfirmModal per §4.2: consequence copy explicitly separates the two truths — *metadata is recoverable for a grace period; the database volumes are destroyed immediately and permanently* — then type-the-name confirm. During removal the card shows `removing` badge + LogStream; on completion the card fades out (200ms) and a neutral toast confirms with an audit-log link.

### 5.10 Audit log
DataTable: timestamp (mono) · user · action badge (neutral; danger tint for destructive actions) · target (linked) · metadata expander (mono JSON). Filter row: user, action type, target type, date range. Read-only by design; no delete affordance exists anywhere in this screen.

### 5.11 Users (admin)
Simple table + invite/create modal: email, role select with one-line descriptions of the three roles. Role badge column. Password reset action.

---

## 6. Interaction & feedback rules

- **Every long operation is observable.** Anything over ~1s gets a spinner-in-button; anything over ~5s (bootstrap, provision, teardown) gets a LogStream. No fire-and-pray buttons.
- **Errors keep their evidence.** Failed operations pin the log tail to the entity (spec §6.1) — errors are never reduced to a toast alone.
- **Optimistic UI only for metadata CRUD** (websites, tags, names). Anything touching SSH/Docker renders server-confirmed state only — TanStack Query polling (5s while any instance is in a transitional status, 30s otherwise).
- **Toasts** (bottom-right, `radius-12`, `shadow-md`): confirmations and non-blocking failures; semantic left border; auto-dismiss 5s except danger (manual dismiss).
- **Role-gating in UI:** actions a role lacks are *hidden*, not disabled — a viewer sees a clean read-only panel, not a wall of grey buttons. (Server-side enforcement is authoritative regardless.)
- **Copy tone** = INITQUBE voice, panel register: confident, direct, precise. Buttons are verbs ("Provision instance", not "OK"). Destructive copy states consequences in plain sentences, no euphemism ("Delete containers and all data volumes for **clienta-prod**. The data cannot be recovered.").

## 7. Accessibility

- Text contrast AA minimum: body `ink`/`neutral-600` on white passes; `neutral-500` reserved for ≥13px secondary text; semantic-on-tint pairs use the 600/700 shade for text, tint only as background.
- Status never encoded by color alone — every StatusBadge carries the label text; log line semantics carry the `✓/✗/›` glyph.
- Full keyboard support: visible `ring-cobalt-400` focus everywhere (already in the kit's button base); modals trap focus; type-to-confirm inputs are labeled; the terminal announces connect/disconnect via `aria-live`.
- `prefers-reduced-motion` disables spark/pulse/lift animations globally (carried from `globals.css`).
- Iframe (Studio) gets a proper `title`; terminal region labeled with server name.

## 8. Implementation notes

- Tailwind v4 `@theme` tokens live in `app/globals.css`, including `--color-terminal-bg: #0d1117`, danger-button shades and status-tint utilities.
- Fonts via `next/font`: Figtree (`--font-figtree`), JetBrains Mono (`--font-jetbrains`) — same variable names the tokens already reference.
- `components/ui/` provides the shared controls; module components use those primitives and tokens for status badges, fields, log streams, terminals, alerts, confirmation dialogs, data tables and empty states.
- xterm.js theme object defined once in `lib/terminal-theme.ts` from the same token values.
