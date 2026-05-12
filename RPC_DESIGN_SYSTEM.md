# RPC Design System & Engineering Guardrails

Authoritative reference for every frontend, DB, and concierge change in `rip-packs-city`. Read top-to-bottom before any edit. The checklist at §0 is non-negotiable.

> **Sync status (2026-05-12):** Re-committed to the repo for the first time. The 2026-05-09 baseline has been reconciled against `CLAUDE.md` and `app/rpc-tokens.css` and folded in: edition-dedup steady-state (Phase 0 hydrator-fix `81e85aa`), listing-divergence reconciliation (`listing_divergence_null_safe_price`), account-linking infrastructure (`linked_accounts` + `analytics_sales_resolved`), the EVM multichain scaffold (`evm_chains` / `wallet_links` + chain-parameterized `lib/evm-rpc.ts`), Pinnacle direct-ASK pipeline (`ask_source='pinnacle_direct'`), and the MCP Phase 1 DB surface applied via Supabase MCP today. §12 (MCP product surface) is intentionally NOT added yet — it will land when the `rpc-mcp-proxy` worker ships in Track D.

---

## §0 — Strict Before-You-Commit Checklist

Run through this on **every** edit. If any box can't be checked, stop and re-read the relevant section.

### Frontend file edits
- [ ] No literal hex (`#E03A2F`, `#080808`, `#F1F1F1`, etc.) outside `app/rpc-tokens.css` — use `var(--rpc-*)` / `var(--tier-*)` / `var(--col-*)` tokens
- [ ] No literal font strings (`'Barlow Condensed'`, `'Share Tech Mono'`) — use `var(--font-display)` / `var(--font-mono)` / `var(--font-body)`
- [ ] Sole exception: `ConsoleGreeting.tsx` `console %c` styling
- [ ] If file is under `app/(collections)/[collection]/*`: NO header / nav / ticker in this file — the layout owns those
- [ ] Per-collection accent: ensure `[data-collection="..."]` lives on an ancestor before referencing `var(--rpc-accent)` (the attribute is what binds the per-collection color)
- [ ] Touch targets ≥44px on mobile-reachable elements
- [ ] No new Supabase client instances — import from `lib/`
- [ ] No bypassing FCL for Flow calls
- [ ] If new page: OG metadata via `/api/og/collection?id={slug}&page={page}`

### DB / API edits
- [ ] LONG-form slug (`nba_top_shot`, `nfl_all_day`, `laliga_golazos`, `disney_pinnacle`, `ufc_strike`) for `sales` / `editions` / `collections.slug`
- [ ] SHORT-form (`topshot`, `allday`, `golazos`, `pinnacle`, `ufc`, `unknown`) for `flowty_transactions` / `flowty_loans` / `flowty_loan_events`
- [ ] Tier filters use `.eq()` with UPPERCASE enum, NEVER `.ilike()`
- [ ] Reading >1000 rows: explicit `.limit(10000)` or RPC (PostgREST caps silently at 1000)
- [ ] Mutating `fmv_snapshots`: delete-then-insert, never upsert; `collection_id NOT NULL`
- [ ] Pinnacle FMV joins: triple `(character_name, set_name, variant_type)` — never `edition_key` alone
- [ ] AllDay leaderboards: use `analytics_sales_resolved` (canonical-owner-resolved) not `analytics_sales` when parent/child wallets matter
- [ ] `/api/admin/feedback` GET filters `feedback_type IS NOT NULL`
- [ ] `apply_migration` only for non-`CONCURRENTLY` DDL (it wraps in a tx); use `execute_sql` for `CREATE INDEX CONCURRENTLY` and `VACUUM`
- [ ] `execute_sql` returns only the last result set per call — one statement per invocation
- [ ] **Any migration applied via Supabase MCP must also be saved as a `.sql` file under `supabase/migrations/` in the same commit.** Otherwise the repo view of the schema diverges from the live DB and any tool that searches `supabase/migrations/` will report functions/tables as missing when they exist at runtime.

### Concierge / FMV
- [ ] Same-turn `get_fmv` tool call — never serve FMV from memory (banned per `a910745`)
- [ ] `get_fmv` returns p10/p50/p90 + sample shape from `editions` + `fmv_snapshots`
- [ ] Don't manually set `shipped_at` / `updated_at` on `support_conversations` — `trg_support_conv_updated_at` owns those

### Commit
- [ ] Direct to `main`, no PR, no feature branch
- [ ] No unrelated modified files riding along
- [ ] Conventional commit prefix: `feat:` / `fix:` / `chore:` / `docs:`
- [ ] Env var changes pulled with `vercel env pull --environment=production`

---

## §1 — Brand Tokens (`app/rpc-tokens.css`)

All tokens live in `app/rpc-tokens.css`, imported via `globals.css`. Every visual value must reference a token. The file has two layers: a v1 base (core palette, tiers, type, utilities) and a v2 layer (POR / video-game / trading-card binder direction) appended below the v1 root. v2 utilities don't clobber v1 — they extend.

### Core palette (v1)
| Token | Value | Use |
|---|---|---|
| `--rpc-red` | `#E03A2F` | Primary accent, active states, CTAs |
| `--rpc-red-hover` | `#FF4D40` | Hover on red CTAs |
| `--rpc-red-muted` | `rgba(224,58,47,0.5)` | Subtle red borders |
| `--rpc-red-bg` | `rgba(224,58,47,0.08)` | Red surface tint |
| `--rpc-red-border` | `rgba(224,58,47,0.3)` | Red borders |
| `--rpc-red-glow` | `rgba(224,58,47,0.25)` | Glow shadows |
| `--rpc-black` | `#080808` | Page bg |
| `--rpc-surface` | `#0D0D0D` | Card / header bg |
| `--rpc-surface-raised` | `rgba(255,255,255,0.03)` | Elevated cards |
| `--rpc-surface-hover` | `rgba(255,255,255,0.06)` | Hover surface |
| `--rpc-border` | `rgba(255,255,255,0.12)` | Default border |
| `--rpc-border-hover` | `rgba(255,255,255,0.18)` | Hover border |
| `--rpc-border-subtle` | `rgba(255,255,255,0.04)` | Faint dividers (table-row borders) |
| `--rpc-border-active` | `rgba(224,58,47,0.6)` | `:active` border state |
| `--rpc-silver` | `#BFC0BF` | Secondary metallic accent |

### Text
| Token | Use |
|---|---|
| `--rpc-text-primary` | `#F1F1F1` — body, headings |
| `--rpc-text-secondary` | `rgba(255,255,255,0.55)` — labels |
| `--rpc-text-muted` | `rgba(255,255,255,0.42)` — meta |
| `--rpc-text-ghost` | `rgba(255,255,255,0.2)` — placeholders |

### Tier colors (each has `--tier-{name}`, `--tier-{name}-bg`, `--tier-{name}-border`)
- `legendary` — `#FFD700`
- `ultimate` — `#FF6B35`
- `rare` — `#818CF8`
- `fandom` — `#34D399`
- `uncommon` — `#14B8A6`
- `common` — `#94A3B8`

UFC Strike-specific tiers (parallel registry, same shape):
- `champion` — `#F59E0B`
- `challenger` — `#818CF8`
- `contender` — `#94A3B8`

### Status
- `--rpc-success` `#34D399` · `--rpc-warning` `#F59E0B` · `--rpc-danger` `#F87171` · `--rpc-info` `#3B82F6`

### Typography
- `--font-display: 'Barlow Condensed', sans-serif` — headings, labels, buttons (uppercase + tracked letterSpacing)
- `--font-mono: 'Share Tech Mono', monospace` — data, timestamps, terminal feel
- `--font-body: 'Barlow Condensed', sans-serif` — body copy
- Sizes: `--text-xs` 9px · `--text-sm` 11px · `--text-base` 13px · `--text-lg` 16px · `--text-xl` 20px · `--text-2xl` 24px · `--text-3xl` 32px

### Spacing / Radii / Shadows / Transitions
- Spacing: `--space-xs` 4px → `--space-2xl` 40px
- Radii: `--radius-sm` 4px → `--radius-xl` 16px, `--radius-full` 50%
- Shadows: `--shadow-card`, `--shadow-elevated`, `--shadow-glow-red`
- Transitions: `--transition-fast` 0.15s · `--transition-normal` 0.25s · `--transition-slow` 0.4s

### Z-index scale
`--z-base` 1 · `--z-dropdown` 50 · `--z-sticky` 100 · `--z-modal` 200 · `--z-chat` 9000 · `--z-toast` 9999

### Layout
- `--max-width: 1440px` — wrap all main content

### v2 layer — POR + video-game + trading-card binder

Appended below the v1 root. Brand direction: Portland Trail Blazers palette, CRT HUD feel, 9-up binder grid, per-collection accents.

**POR palette**: `--por-red #E03A2F` · `--por-black #0C0C0C` · `--por-silver #BFC0BF` · `--por-white #F1F1F1` · `--por-pin #2A2A2A`

**Per-collection accent registry** (drives `--rpc-accent` via `[data-collection]` selector — see §1a):
- `--col-nba-top-shot` `#E03A2F`
- `--col-nfl-all-day` `#4F94D4`
- `--col-laliga-golazos` `#22C55E`
- `--col-disney-pinnacle` `#A855F7`
- `--col-ufc` `#EF4444`

**CRT / video-game effects**: `--scan-line` · `--scan-glow` · `--scan-glow-strong` · `--neon-text-glow`

**Trading-card holo gradients** (v2 overlay system, applied via `.rpc-holo-overlay*`):
- `--holo-base` (neutral red sheen)
- `--holo-legendary` · `--holo-ultimate` · `--holo-rare` · `--holo-fandom`

**Binder (9-up grid) dimensions**: `--binder-gap` 14px · `--binder-card-min` 180px · `--binder-card-max` 240px · `--binder-slot-ratio` 1.45 · `--binder-sleeve-bg` · `--binder-sleeve-edge`. Mobile (<640px) shrinks to gap 10px / min 140px.

### §1a — Per-collection theming convention

The accent registry binds via a `[data-collection="..."]` attribute selector. Any ancestor with that attribute sets `--rpc-accent` for its descendants. Default (no ancestor): `--rpc-accent = var(--por-red)`.

Attribute values: `nba-top-shot` · `nfl-all-day` · `laliga-golazos` · `disney-pinnacle` · `ufc`.

Apply accent via `.rpc-accent-bg` · `.rpc-accent-border` · `.rpc-accent-text` · `.rpc-accent-glow`. Do NOT reference `--col-{slug}` directly in components — always go through `--rpc-accent` so accent inheritance works.

---

## §2 — Class Families

Prefer these over inline styles where the pattern is established. Composition: combine layout + tier + holo classes on the same element.

### Surfaces
- `.rpc-card` — surface-raised card with hover border bump
- `.rpc-card-neon` — red-bordered card with CRT glow (hero stats, today's deal)
- `.rpc-hud` — HUD-style panel with notched top edge (game UI feel)
- `.rpc-hot-deal` — red left-stripe + tinted bg (sniper rows)

### Buttons / chips
- `.rpc-btn-primary` — red gradient CTA
- `.rpc-btn-ghost` — bordered transparent button
- `.rpc-chip` / `.rpc-chip.active` — filter chips (sniper, sets)
- `.rpc-filter-button` / `.rpc-filter-button--active` — bordered filter button (wallet analytics)
- `.rpc-filter-toggle` / `.rpc-filter-toggle--active` — compact filter toggle (10px text)
- `.rpc-filter-select` / `.rpc-filter-input` — branded form controls (red focus ring)

### Typography
- `.rpc-heading` — display-font heading (uppercase, 0.04em tracked)
- `.rpc-label` — uppercase mono label (xs, tracked 0.2em)
- `.rpc-mono` — mono data block (tabular-num friendly)

### Stats
- `.rpc-stat-tile` — dashboard/overview stat block
- `.rpc-stat-eyebrow` / `.rpc-stat-value` / `.rpc-stat-caption` — internal slots

### Tables
- `.rpc-table-wrapper` — outer scroll container with rounded border
- `.rpc-table` — base table (≥900px min-width, tabular-num)
- `.rpc-thead-scanline` — CRT scanline overlay on thead
- `.rpc-table-row--expanded` — red inset-left stripe on expanded rows
- `.rpc-table-cell--mono` / `--player` / `--muted` — cell variants
- `.rpc-table-empty` / `.rpc-table-load-more` — empty + pagination states

### Expand panels (row drill-down)
- `.rpc-expand-panel` · `.rpc-expand-section` · `.rpc-expand-section-eyebrow` · `.rpc-expand-grid` · `.rpc-expand-field` · `.rpc-expand-field-label` · `.rpc-expand-field-value` · `.rpc-expand-field-value--debug` · `.rpc-expand-link` · `.rpc-expand-link--muted`

### Tier display
- `.rpc-tier-{legendary,ultimate,rare,fandom,uncommon,common}` — border-color helpers for binder slots
- `.rpc-tier-stripe.{tier}` — 2px top stripe overlay
- `.rpc-tier-glow-{legendary,ultimate,rare}` — text-shadow glow

### Holo (v1 shimmer + v2 overlay — both exist, do not collapse)
- `.rpc-holo-{legendary,ultimate,rare}` — v1 ::after shimmer animation (6 existing pages depend on these names; do not rename)
- `.rpc-holo-overlay` + `.rpc-holo-overlay-{legendary,ultimate,rare,fandom}` — v2 mix-blend-screen overlay (use on `.rpc-binder-slot` children)

### Binder (trading-card grid)
- `.rpc-binder` — auto-fill grid (180–1fr)
- `.rpc-binder-slot` — aspect-ratio 1:1.45 sleeve
- `.rpc-binder-bg` — repeating grid lines (album-page feel)
- `.rpc-serial-pill` — top-right serial overlay on card art

### Per-collection accent (driven by ancestor `[data-collection]`)
- `.rpc-accent-bg` · `.rpc-accent-border` · `.rpc-accent-text` · `.rpc-accent-glow`

### FMV deltas
- `.rpc-fmv-delta-up` / `.rpc-fmv-delta-down` — success/danger chevrons

### Effects
- `.rpc-scanlines` — body-level CRT scanlines (apply on `<body>`)
- `.rpc-scan-crt` — opt-in, scoped CRT scanline overlay (use when only one section needs it)
- `.rpc-live-pill` — flickering red LIVE pill
- `.rpc-skeleton` — red-tinted pulse loader

---

## §3 — Routing & Layout Ownership

```
app/
  page.tsx                           ← marketing home (wallet-search hero)
  layout.tsx                         ← root shell
  global-error.tsx
  not-found.tsx

  (collections)/                     ← route group, /collections prefix stripped
    [collection]/
      layout.tsx                     ← OWNS header, nav, ticker. Pages MUST NOT redeclare these.
      ActiveCollectionSync.tsx       ← layout helper (not a route)
      overview/page.tsx
      collection/page.tsx
      packs/page.tsx
      sniper/page.tsx
      sets/page.tsx                  ← n/a for Pinnacle
      market/page.tsx
      analytics/page.tsx
      pack/[id]/page.tsx
      set/[id]/page.tsx
      series/[id]/page.tsx
      player/[id]/page.tsx
      team/[id]/page.tsx
      edition/[id]/page.tsx
      moment/[id]/page.tsx
      profile/[username]/page.tsx
      fast-break/page.tsx            ← Top Shot only (TS game surface)
      road-to-the-ring/page.tsx      ← Top Shot only (RTR game surface)
    disney-pinnacle/                 ← static override (matches before [collection])
    panini-blockchain/                ← static override
    layout.tsx                       ← group-level layout (rarely modified)

  (analytics)/
    analytics/page.tsx               ← /analytics top-level dashboard

  dashboard/                         ← auth-gated; /profile → /dashboard 308. Flat structure (NOT a route group).
    page.tsx
    layout.tsx
    alerts/
    notifications/
    trade-hub/

  profile/[username]/page.tsx        ← public profile (top-level), served from /api/public/profile/[username]
  moment/[id]/page.tsx               ← top-level cross-collection moment page
  edition/[id]/page.tsx              ← top-level edition page
  share/[wallet]/page.tsx            ← shareable collection card
  admin/                             ← internal tools (RPC_ADMIN_TOKEN gated)
  api/                               ← all API routes
  auth/confirm/page.tsx              ← parses window.location.hash → setSession (Supabase IMPLICIT flow)
  login/                             ← magic-link sign-in (not /auth/login)
  early-access/, about/, blog/, legal/, privacy/, terms/, pricing/, pinnacle/, nba/, out/
```

**Hard rules:**
- Any new page under `(collections)/[collection]/*` renders content only. Headers, nav rails, ticker bars come from the layout. Adding a second header anywhere in the subtree is a regression.
- The `dashboard/` tree is flat. Do not introduce a `(dashboard)` route group without explicit refactor scope.
- The `(collections)/` group has static overrides (`disney-pinnacle/`, `panini-blockchain/`) that match before the dynamic `[collection]` segment. Don't add a sibling override without thinking through the precedence.
- Common collection tabs are `overview`, `collection`, `sniper`. Top Shot adds `packs`, `sets`, `market`, `fast-break`, `road-to-the-ring`. Pinnacle drops `sets`. Confirm tab availability against the `[collection]` value before linking.

---

## §4 — Collection-String Conventions (TWO SYSTEMS — DO NOT UNIFY)

### LONG-form (use in: `sales`, `editions`, `collections.slug`, route params)
`nba_top_shot` · `nfl_all_day` · `laliga_golazos` · `disney_pinnacle` · `ufc_strike`

### SHORT-form (use in: `flowty_transactions`, `flowty_loans`, `flowty_loan_events`, `analytics_sales` view output)
`topshot` · `allday` · `golazos` · `pinnacle` · `ufc` · `unknown` / `other`

- `flowty_transactions` has CHECK constraint `flowty_transactions_collection_check` whitelisting short-form. Writing `'ufc_strike'` to a flowty_* table fails at INSERT. `lib/flowty-tx-classifier.ts` MUST emit `'ufc'` not `'ufc_strike'`.
- The `analytics_sales` view translates LONG → SHORT via CASE.
- Route-attribute form (kebab-case, used in `[data-collection]` selectors and route segments): `nba-top-shot` · `nfl-all-day` · `laliga-golazos` · `disney-pinnacle` · `ufc`. NOT interchangeable with DB long-form.
- Collection UUIDs (use when joining to `collections.id`):
  - Top Shot `95f28a17-224a-4025-96ad-adf8a4c63bfd`
  - AllDay `dee28451-5d62-409e-a1ad-a83f763ac070`
  - Golazos `06248cc4-b85f-47cd-af67-1855d14acd75`
  - UFC `9b4824a8-736d-4a96-b450-8dcc0c46b023`
  - Pinnacle `7dd9dd11-e8b6-45c4-ac99-71331f959714`

---

## §5 — DB Gotchas That Bite Frontend

- **PostgREST 1000-row cap** — silent. Always `.limit(10000)` or wrap in RPC for large reads. Note: the cap applies to SETOF/TABLE returns but NOT to scalar `text[]` / `jsonb` returns — prefer scalars for >1000-element results.
- **`fmv_snapshots`** — partitioned by date. Delete-then-insert, never upsert. `collection_id NOT NULL` always. Daily duplicates are intentional history, not a bug.
- **`fmv_confidence` enum** — UPPERCASE: `HIGH` / `MEDIUM` / `LOW` / `NO_DATA` / `ASK_ONLY` / `SALES_ONLY` / `STALE`. Two confidence vocabularies live in the DB — `nba_player_projections.confidence` uses 3-letter `MED` instead of `MEDIUM`. Don't cross-pollinate.
- **`tier_type` enum** — UPPERCASE: `COMMON` / `FANDOM` / `RARE` / `LEGENDARY` / `ULTIMATE`. UFC Strike uses its own vocabulary: `CHALLENGER` / `CONTENDER` / `FANDOM`. Filter with `.eq()`, never `.ilike()`.
- **`saved_wallets`** — columns: `wallet_addr`, `username`, `user_id`, `cached_fmv_usd`, `nickname`. **No `owner_key` column** — app-level `owner_key = lower(username)`. Unique on `(user_id, wallet_addr, collection_id)`.
- **`trophy_moments.slot`** — CHECK 1–6. Picker UI uses `TrophyPickerModal` (not `PinModal`); trophy-suggestions endpoint is `/api/profile/top-moments`; always call the 4-arg `get_user_top_owned_moments` overload (3-arg returns NULL thumbnails).
- **`sales`** — year-partitioned (`sales_2020`–`sales_2026`). `transaction_hash` for dedup (unique index on `sales_2026`).
- **`wallet_moments_cache` (wmc)** — UNIQUE `(wallet_address, collection_id, moment_id)`. `edition_key` is denormalized; populated by JOIN-to-editions backfill. AllDay note: sniper-feed emits `set:play` intEditionKey but wmc stores plain int for AllDay — do not drop `!isAllDay` ownership-UI guards until format is unified.
- **`linked_accounts`** — composite PK `(parent_addr, child_addr)`. Reader RPCs: `get_linked_parents`, `get_linked_children`, `get_linked_all`, `resolve_canonical_owner`. View `analytics_sales_resolved` is the canonical-owner-collapsed projection — use it for leaderboards / Top Buyers / Top Sellers where parent-child duplication would distort.
- **`evm_chains` + `wallet_links`** — multichain EVM read scaffold. `lib/evm-rpc.ts` is chain-parameterized (Flow EVM 747 + Base 8453); env vars `EVM_PROXY_{URL,SECRET}_<SLUG>` with legacy `FLOWEVM_` fallback. `base-proxy` worker is built but not deployed yet.
- **Edition-dedup migration — deferred.** Phase 0 hydrator-fix shipped 2026-05-08 (`81e85aa`). The actual dedup pass is paused pending 24h orphan-rate verification — do NOT run dedup until that signal is green.
- **Listing-divergence reconciliation** — hardened 2026-05-11 via `listing_divergence_null_safe_price` migration. Cross-source ask compares now tolerate NULL asks on either side.
- **Pinnacle direct-ASK pipeline** — Phase 2C shipped 2026-05-11. Reconcile RPC writes `ask_source='pinnacle_direct'` from on-chain events. `fmv_snapshots` remains empty for `disney_pinnacle` (sales-only path).
- **`pg_cron`** — NOT installed. Schedule via cron-job.org.
- **`apply_migration`** — wraps in a transaction. Never use for `CREATE INDEX CONCURRENTLY` or `VACUUM` — use `execute_sql` standalone.
- **`execute_sql`** — multi-statement returns only the last result set. One statement per call.
- **`query_sql`** — rejects data-modifying CTEs. Use a SECDEF RPC instead.
- **Repo drift** — every migration applied via Supabase MCP `apply_migration` must also be saved as a `.sql` file under `supabase/migrations/` in the same commit. Otherwise the repo's view of the schema diverges from the live DB and code-search-based tools (including Claude Code) will report functions / tables as "missing" when they exist at runtime.

### §5a — MCP Phase 1 surface (live in DB, no worker yet)

Applied via Supabase MCP on 2026-05-12 as version `20260512155009`. The migration must also be saved under `supabase/migrations/` as part of Track B before the worker ships in Track D.

- Table: `mcp_api_keys (key_id, key_hash, key_prefix, wallet_address, label, plan, status, scopes, created_at, last_used_at, revoked_at, expires_at)` — RLS service-role-only, key_hash = sha256-hex, raw value shown once.
- RPCs (service_role only): `mcp_validate_api_key(p_key_hash)`, `mcp_issue_api_key(p_wallet_address, p_label, p_scopes)`, `mcp_revoke_api_key(p_key_id, p_wallet_address)`, `mcp_list_keys(p_wallet_address)`, `mcp_log_tool_call(p_wallet_address, p_tool_name, p_metadata)`.
- View: `v_mcp_usage_today` — hourly rollup of `usage_events` where `feature_name LIKE 'mcp\_%'` over the last 24h.
- `feature_quotas` rows (`feature_name='mcp_query'`): `free` 100/day · `pro` 5000/day · `founding` unlimited · `partner` unlimited.

The Phase 1 surface is read-plane only. Agent execution / writes / on-chain transactions are deferred to Phase 2+. **§12 (product-level MCP doc) will be added in this file when the `rpc-mcp-proxy` Cloudflare Worker ships in Track D, not before.**

---

## §6 — Concierge Structural Rules

1. **Pinnacle FMV** — NEVER join by `edition_key` alone. Always triple `(character_name, set_name, variant_type)` per commit `92aab30`. Cadence uses `Int` not `UInt64`.
2. **Memory-FMV is banned** (`a910745`) — must tool-call `get_fmv` in the same turn the value is reported.
3. **`get_fmv`** — reads `editions` + `fmv_snapshots` primary, returns p10/p50/p90 + sample shape.
4. **Tier filter** — enum `.eq` not `.ilike` per `f55e022` + `e9c90e5`.
5. **`trg_support_conv_updated_at`** — owns `shipped_at` / `updated_at`. Never set manually.
6. **`/api/admin/feedback` GET** — must filter `feedback_type IS NOT NULL`.
7. **ULTIMATE FMV** — `recalc_ultimate_fmv()` = `algo=ultimate-v1`, `MIN(non-special sale, ask)`. Special = `#1` / perfect / jersey serial. Circ=1 skips. View `v_ultimate_fmv_state`.
8. **AllDay buyer in sales** — contract address `0xedf9df96c92f4595` (NFTStorefrontV2), not the real buyer. Resolve via `analytics_sales_resolved` view + `linked_accounts` for canonical owner.

---

## §7 — Collection-Specific Cadence/API Quirks

- **AllDay** — `borrowMomentNFT` does NOT exist; borrow as `borrowNFT(id)! as! &AllDay.NFT`. `EditionData` has NO `.metadata`; chain `getEditionData → getPlayData → play.metadata`.
- **AllDay / Golazos / UFC sales** — on Flowty's NFTStorefrontV2 fork at `0x3cdbb3d569211ff3` (NOT Dapper's). `nftType` emits as plain String, not Type.
- **UFC** — `UFC_NFT.MomentNFTCollectionPublic` does NOT exist in Cadence 1.0. Import only for `CollectionPublicPath`. Borrow as `NonFungibleToken.CollectionPublic` + `borrowNFT(id)!`. `Traits` FAILS (AnyStruct `.toString()`). Fighter from edition name split `"|"`. UFC Strike tier vocabulary: `CHALLENGER / CONTENDER / FANDOM`.
- **Pinnacle** — wallet-walk scripts use plain `&{NonFungibleToken.Collection}` + `borrowNFT`. `MetadataViews.ResolverCollection` is NOT exposed at the standard MetadataViews address for Pinnacle.
- **Paginated mega-wallet chunks** — AllDay paginated walks chunk by 1000; Pinnacle by 500. Per-NFT MetadataViews work blows the Cadence computation budget faster than ID-only scripts.
- **Top Shot GQL** — `searchEditions` uses plural `bySetIDs` / `byPlayIDs`. `set { flowId }` lowercase, `play { flowID }` uppercase D. Requires `Origin: https://nbatopshot.com` + `Referer` headers; route through `topshot-proxy` worker (Cloudflare blocks Vercel IPs).
- **`TopShot.getSetData(setID).tier`** — does NOT exist. `QuerySetData` only exposes `setID / name / series`. Tier comes via GQL or per-NFT MetadataViews / modal-set inference post-pass.
- **Top Shot series map** (on-chain `UInt32` → display): `0="Series 1"`, `2="Series 2"`, `3="Summer 2021"`, `4="Series 3"`, `5="Series 4"`, `6="Series 2023-24"`, `7="Series 2024-25"`, `8="Series 2025-26"`. No series=1 on-chain, no "Beta".
- **Listing cache** — all routes go through `flowty-proxy` Supabase edge function (Flowty blocks Vercel IPs). TS uses `onConflict:"flow_id"`. `get_collection_stats` TS `listing_count` reads `badge_editions.low_ask`, NOT `cached_listings`. Flowty Pinnacle floor is a uniform $1 (`upstream_floor_only=true`) — Pinnacle ASK should come from the direct pipeline (`ask_source='pinnacle_direct'`), not Flowty.

---

## §8 — Flow Cadence Script Encoding

- `btoa()` breaks on Unicode — always `Buffer.from(str, 'utf8').toString('base64')`
- Each argument: `btoa(JSON.stringify({type, value}))` — NOT raw object, NOT JSON string
- UInt64 / numeric Cadence args must be `String(v)` in Flow REST calls, not raw numbers
- Response: `atob(raw.trim().replace(/^"|"$/g,''))` → `JSON.parse`
- `access(all)` required (not `pub`)
- Cadence test harness: `npm run test:cadence` is the regression net (currently red on purchase-moment C1+C2 audit; flips green when audit fixes land). Type-check via `flow cadence lint`, no emulator.

---

## §9 — Mobile

- 44px minimum touch targets on anything tappable
- `MobileNav` is 5-tab — coordinate any new top-level route with it
- Auth uses Supabase IMPLICIT flow; magic links return tokens in URL hash fragment. `/auth/confirm` parses `window.location.hash → setSession`.
- Respect safe-area insets on full-bleed sections (`env(safe-area-inset-*)`)
- Mobile screen budget: ~6–8 sentences visible at a time. Don't bury CTAs below 2 screenfuls.

---

## §10 — Division of Labor

- **Claude (Claude.ai chat)** — DB/migrations/diagnosis via Supabase MCP, Vercel MCP for deploy monitoring, architecture decisions, skill/doc drafting. **Must hand the SQL of any applied migration over as a file artifact so Claude Code can save it under `supabase/migrations/` in the same commit.** Project-knowledge artifacts (skills, design docs) only exist in the chat context — they must be explicitly committed to the repo before Claude Code can rely on them.
- **Claude Code** — file-level repo work. Always complete-replacement files, never diffs or snippets. Prompts are plain prose for iPhone copy-paste. Must push back when a prompt references infrastructure the repo doesn't contain rather than inventing it.
- **Trevor** — direct commits to `main`, no PRs, no feature branches.

---

## §11 — Tools & External Endpoints (Quick Reference)

### Supabase MCP
- `execute_sql` (reads, single statement, last result only)
- `apply_migration` (DDL, transactional — NOT for `CONCURRENTLY` / `VACUUM`)
- `deploy_edge_function` (requires `verify_jwt: false` + `[{name:'index.ts', content:'...'}]`)

### Vercel MCP
- `list_deployments` needs both `projectId` + `teamId`
- `get_deployment_build_logs` use `limit: 200+`
- `web_fetch_vercel_url` GET only; truncates ~50 chars in `get_runtime_logs`

### Cloudflare Workers (all on `*.tdillonbond.workers.dev`)
- `topshot-proxy` — TopShot GQL `/` or `/topshot` → `public-api.nbatopshot.com/graphql`; AllDay GQL `/allday` → `public-api.nflallday.com/graphql`; AllDay consumer `/allday-consumer` → `nflallday.com/consumer/graphql`
- `pinnacle-proxy` — Pinnacle GQL
- `pinnacle-events-proxy` — Pinnacle on-chain event reads (direct-ASK pipeline)
- `spork-proxy` — Flow historical spork access (port 8070)
- `hybrid-custody-proxy` — HybridCustody event reads at `0xd8a7e05a7ac670c0`
- `sports-proxy` (deployed as `rpc-sports-proxy.tdillonbond.workers.dev`) — NBA stats / DK projections / cdn.nba.com
- `odds-proxy` — the-odds-api.com pass-through with API-key injection
- `reddit-proxy` — Reddit API
- `flowevm-proxy` — Flow EVM JSON-RPC (chain 747)
- `base-proxy` — Base EVM JSON-RPC (chain 8453), built but not deployed

Plus `flowty-proxy` as a Supabase edge function (Flowty blocks Vercel IPs).

### Three independent worker auth-rotation surfaces — DO NOT conflate

1. **`TS_PROXY_SECRET` via `X-Proxy-Secret` header** — `topshot-proxy`, `pinnacle-proxy`, `pinnacle-events-proxy`, `sports-proxy`, `odds-proxy`, `reddit-proxy`, and the AllDay routes on `topshot-proxy`. Rotate via `wrangler secret put PROXY_SECRET --name <worker>` for each, plus the matching Vercel env var.
2. **`INGEST_SECRET_TOKEN` via `Authorization: Bearer` header** — `hybrid-custody-proxy` and Vercel ingest routes. Rotate together; X-Proxy-Secret rotation does NOT cover this.
3. **`SPORK_PROXY_SECRET`** — `spork-proxy` only (port 8070 historical block-height reads). Rotate independently.

EVM proxies use a separate `EVM_PROXY_SECRET_<SLUG>` convention.

### Upstream endpoints
- Top Shot GQL — `https://public-api.nbatopshot.com/graphql` via `topshot-proxy`
- AllDay GQL — `https://public-api.nflallday.com/graphql` AND `https://nflallday.com/consumer/graphql` — non-overlapping schemas, both via `topshot-proxy` on `/allday` and `/allday-consumer`
- Flowty — `api2.flowty.io` via `flowty-proxy` edge fn
- Flow REST — `https://rest-mainnet.onflow.org/v1/scripts`. Past sporks at `access-001.mainnet{N}.nodes.onflow.org:8070`.

---

## §12 — MCP Server (Flow Agents Public Surface)

Public Model Context Protocol surface that lets other apps and AI agents read RPC collector intelligence on behalf of a user. Self-serve key issuance at `/dashboard/api-keys`. Shipped Track D + E (2026-05-12).

### Endpoint
- **URL**: `https://rpc-mcp.tdillonbond.workers.dev/mcp`
- **Transport**: streamable HTTP per [MCP spec `2025-06-18`](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). Single POST endpoint, JSON-RPC 2.0. v1 returns plain `application/json` — no SSE, no session management, no KV cache.
- **Companion endpoints on the worker**: `GET /health` (returns `{ok, version, supabase_reachable, rpcs_reachable, build_sha}`) and `GET /` (minimal HTML landing).

### Authentication
- Bearer token: `Authorization: Bearer rpc_mcp_live_<token>`.
- Tokens are issued through `/dashboard/api-keys`. Raw token shown exactly once at issuance, never persisted in plaintext. Worker validates via `mcp_validate_api_key(p_key_hash text)` against sha256-hex of the bearer.
- Server-side route auth on `/api/mcp/keys` reuses the canonical `getCurrentUser()` + `get_user_saved_wallets(p_user_id)` resolver — the same path `/api/profile/cost-basis-summary` and `/api/profile/verify-challenge` use. Do not invent a parallel session→wallet path anywhere else.

### Quota tiers (`feature_quotas` rows, `feature_name='mcp_query'`)
| Plan | Daily cap |
|---|---|
| `free` | 100 |
| `pro` | 5000 |
| `founding` | unlimited |
| `partner` | unlimited |

Quota exceeded → HTTP 429 with `Retry-After` set to seconds until UTC midnight.

### Six tools
Worker-facing names and one-line summaries. Full schemas, parameter examples, gap-string vocabulary, and known-coverage gaps live in [`docs/mcp-tool-mapping.md`](docs/mcp-tool-mapping.md) — keep that doc in sync if you change a tool.

| Tool | Summary |
|---|---|
| `get_fmv` | FMV and trade-context signals (wap, sales velocity, asks, confidence, liquidity rating) for one moment edition. Requires `(edition_key, collection_slug)` because external_ids collide across collections. |
| `get_sniper_deals` | Undervalued asks within one collection — discount %, ask, FMV, buy link. TopShot + AllDay backed; others return `supported:false`. |
| `compute_pack_ev` | Expected value of opening a pack distribution at current pool depletion. |
| `find_set_completion_path` | For a wallet + set, full missing-edition list with cheapest current ask + source per missing piece. TopShot + AllDay only. |
| `lookup_wallet` | Cross-collection portfolio summary — per-collection FMV, moment counts, tier breakdowns, diversity score. Composes `holdings_summary` + `get_wallet_portfolio`. |
| `get_badge_data` | Curated badges for one moment edition (rookie mints, three-star rookies, milestone plays). Backed by `get_edition_badges_unified` after the 2026-05-12 search_path fix. |

### Architectural rules (non-negotiable for any future tool)
1. **Every tool wraps an existing RPC.** No parallel pricing, no parallel set-progress logic, no second source of truth. If the wrap isn't clean, write an adapter (`mcp_*` SECDEF function) — never reimplement.
2. **Every tool returns `gaps text[]`.** Honest coverage reporting. Format: `<dimension>_<reason>`. Pad with empty `[]` not zeros.
3. **The worker never crashes on upstream failure.** Supabase 5xx surfaces as `upstream_supabase_unavailable_*`; adapter exceptions surface as `adapter_exception_*`; unknown slugs surface as `unknown_collection_slug_*`. Hard HTTP 401 / 429 only on the auth and quota paths.

### Observability
- **`v_mcp_usage_today`** — hourly rollup over the last 24h. Drives the worker's usage telemetry surface.
- **`usage_events`** — raw log written by `mcp_log_tool_call(wallet, tool_name, metadata)`. Metadata includes `duration_ms`, `gaps_count`, and `error` if applicable. Fired regardless of success/failure (but NOT on the 401 / 429 paths).
- `pipeline_runs` not applicable — the worker is request-driven, not cron-driven.

### Operational notes
- **`workers_dev = true`** in `wrangler.toml` is REQUIRED. Without it, deploys succeed silently with no public URL.
- **`MCP_INTERNAL_SECRET`** is provisioned via `wrangler secret put` but reserved for future inter-worker calls — specifically the cache-flush trigger from `/api/mcp/keys` DELETE to invalidate worker-side state if/when caching ships. v1 has no KV namespace and consumes no internal secret.
- **`BUILD_SHA`** is embedded via `wrangler deploy --var BUILD_SHA:$(git rev-parse --short HEAD)` (also wired into `npm run deploy` in `workers/rpc-mcp-proxy/package.json`). Reported on `/health`.
- **No KV / Cache API in v1.** Every request hits Supabase directly. Add caching only if hot-path metrics warrant it; the FMV freshness story is cleaner without a worker-side cache.
- **No SSE / no session management in v1.** All responses are plain `application/json`. `GET /mcp` and `DELETE /mcp` return HTTP 405.

---

*Last updated: 2026-05-09 (baseline) · 2026-05-12 (re-committed to repo with sync notes — see banner) · 2026-05-12 (Track E: §12 added, MCP public surface complete). Living doc — update when rules change, not when memory drifts.*
