# Rip Packs City — Claude Code AI Assistant Configuration

## Development workflow (READ FIRST)

- Work directly on the `main` branch. Do NOT create `claude/*` or other feature branches.
- Commit and push directly to `main`. Do NOT open pull requests.
- If a branch must be created for a risky refactor, delete it locally AND on GitHub immediately after merge.
- Always run the smoke test after deploying changes.
- Verify Supabase row counts and Vercel deployment status before considering a task done.

## Project overview

Rip Packs City (RPC) is a production-grade NBA Top Shot collector intelligence platform competing directly with LiveToken. It targets serious collectors with analytics, deal-finding, sniper tools, FMV pricing, and badge tracking. Trevor (founder) holds an official Portland Trail Blazers Team Captain designation on NBA Top Shot — a key brand differentiator.

Stack: Next.js 16 App Router, React 19, TypeScript 5, Tailwind 4, @onflow/fcl, Supabase, Vercel.

Live: https://rip-packs-city.vercel.app
Repo: github.com/jamesdillonbond/rip-packs-city (public)

---

## Recent sessions

### April 26, 2026 — Flowty failed-tx monitor

**Flowty failed-tx monitor (Apr 26):**
- `/api/flowty-tx-scanner` — block scanner running every 5 min via cron-job.org. Scans for txs touching Flowty's NFTStorefrontV2 fork (`0x3cdbb3d569211ff3`) or Dapper's NFTStorefrontV2 (`0x4eb8a10cb9f87357`). Captures successes (lightweight) and failures (full classified rows).
- `/api/wallet-preflight?address=...&collection=...&count=N` — pre-flight diagnostic preventing `STORAGE_CAPACITY_EXCEEDED` and other readiness failures before bulk-list submission. Calibrated `bytesPerListing=500` from on-chain `ListingDetails` field-level analysis.
- `/api/flowty-monitor/status` — unified JSON endpoint over the dashboard views; bearer-auth gated.
- Tables: `flowty_transactions` (year-irrelevant, primary by `tx_hash`), `flowty_scanner_state` (single-row cron position).
- Views: `flowty_scanner_health` (HEALTHY/LAGGING/STALE), `flowty_daily_summary`, `flowty_failure_summary` (with denominator + `failure_rate_pct`), `flowty_top_failing_wallets`, `flowty_storage_cap_cohort`, `flowty_gas_funds_cohort` (1118 errors, distinct from in-execution INSUFFICIENT_BALANCE).
- Classifier: `lib/flowty-tx-classifier.ts` — 15 categories; collection inference is event-payload-first (authoritative `nftType`) with script-import fallback.
- Known: failure rows often classify as `collection: unknown` because failed txs don't emit `ListingCompleted` events. Successes hit 100%.

---

### April 21, 2026 — Storefront Audit Pipeline Session (Flowty ecosystem health)

Shipped

- Diagnosed wallet `0xf77bf547fccf6656` bulk-listing failure: 148 expired listings clogging the NFTStorefrontV2 storefront against the 174/200 cap. Cleared on-chain via `cleanupExpiredListings(fromIndex: 0, toIndex: 173)` signed by the hot wallet — tx `3c2a42bc`.
- Built end-to-end ecosystem scan + cleanup pipeline:
  - `scan-storefront-events` Supabase Edge Function: auto-resumes from block `85000000`, processes 49,800 blocks per invocation, upserts wallet addresses extracted from `NFTStorefrontV2.ListingAvailable` events into `storefront_audit_wallets`.
  - `audit-storefront-wallets` Supabase Edge Function: processes 50 unaudited wallets per run, reads on-chain storefront state, flags rows with `expired_listings >= 20` as `cleanup_status = 'pending'`.
  - `scripts/cleanup-storefront-wallets.mjs`: reads pending wallets from `storefront_audit_wallets`, signs and sends `cleanupExpiredListings` via Flow CLI (`flow transactions send cleanup.cdc ...`), then updates `cleanup_status` to `cleaned` / `error` with `cleanup_tx_id`. Uses the standard `readFileSync` `.env.local` loader pattern; run with `node --env-file=.env.local scripts/cleanup-storefront-wallets.mjs --dry-run` to preview, drop `--dry-run` to execute.
- Hot wallet for cleanup signing: `0x3aa11c84d776838f` (Key 0, ECDSA_secp256k1, SHA2_256, throwaway, **no HybridCustody / account linking**). `flow.json` lives in repo root, is gitignored (added to `.gitignore` under the Flow CLI section alongside `flow.json` and the bare `flow` filename), and must be populated manually with the private key before running cleanup.
- Two cron-job.org jobs driving the pipeline:
  - `scan-storefront-events` (job ID `7511616`, schedule `*/3 * * * *`): POST `https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/scan-storefront-events` with `Authorization: Bearer $INGEST_SECRET_TOKEN`, empty JSON body, every 3 minutes. Becomes a no-op once caught up to chain tip.
  - `audit-storefront-wallets` (job ID `7511621`, schedule `*/5 * * * *`): POST `https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/audit-storefront-wallets`, same auth, empty body, every 5 minutes.

Key constants (Storefront audit)

- `storefront_audit_wallets` table: columns include `address`, `expired_listings`, `cleanup_status` (`pending | cleaned | error`), `cleanup_tx_id`, `cleaned_at`. Scan function is the writer for `address` + listing-count fields; audit function writes `cleanup_status`.
- Scan starting block: `85000000`. Per-invocation span: 49,800 blocks.
- Audit threshold: `expired_listings >= 20` → `cleanup_status = 'pending'`.
- Never use a wallet with HybridCustody / account linking as the hot wallet for automated Flow CLI signing — linking complicates key-path resolution and risks signing against a child account. Use a fresh, unlinked account (current: `0x3aa11c84d776838f`).
- `flow.json` is gitignored — every new machine or clone must paste the private key locally before cleanup can run.

### April 21, 2026 — Phase 4 Session (multi-collection concierge + auth-keyed profile)

Shipped

- Concierge v2: multi-collection aware system prompt; consumes collectionId + userEmail; added `search_across_collections` tool (parallel cached_listings queries by player_name ILIKE across 4 published collection UUIDs). Existing tools (search_live_deals, search_catalog_deals, get_fmv, check_wallet) now accept optional collectionId and scope the downstream Supabase/API calls accordingly.
- SupportChatConnected now fetches `/api/profile/me` and passes userEmail down to the chat so the model can greet by identity.
- SupportChat PAGE_DEFAULTS updated: market + analytics pages get dedicated per-collection suggestions ("Show everything under $20", "Top sales this week", etc).
- Auth-based data model: `saved_wallets`, `trophy_moments`, `recent_searches`, `profile_bio` all truncated + reshaped — owner_key dropped, user_id UUID NOT NULL with DEFAULT auth.uid() and FK to auth.users(id) ON DELETE CASCADE. `saved_wallets` gained `collection_id`. `profile_bio` gained `username TEXT UNIQUE` (public handle for /profile/[username]). RLS policies rewritten — own-row R/W on all four; `trophy_moments` and `profile_bio` also expose a public SELECT policy so the /api/public/profile/[username] route can bundle the data. Greenfield: 1 pre-existing test user (Trevor) truncated; no user-facing data lost.
- New tables: `follows (follower_user_id, followee_user_id)` with a CHECK that prevents self-follow; `collection_preferences (user_id, collection_id, favorited)`.
- New routes: `/api/profile/follows` (GET/POST/DELETE by username), `/api/profile/activity` (last-20-over-7d sales for followed users' saved wallets), `/api/profile/favorites`, `/api/profile/hero-moment` (highest-FMV moment across user's saved wallets, joins moments → fmv_snapshots), `/api/public/profile/[username]` (unauthed — bio + trophies + privacy-stripped wallet summaries).
- Rewritten routes to require user session: trophy, saved-wallets, recent-searches, bio (all call `requireUser()` and key queries on `auth.uid()`).
- /profile page fully rewritten: Hero Holo Moment card (uses `.rpc-binder-slot` + tier-aware `.rpc-holo-*` primitives), stats tiles, 6-slot trophy case, saved-wallets with collection dropdown + nickname, favorite-collections star UI driving a merged news feed, friend activity widget, recent searches, plus a separate "Link Flow wallet" section with ConnectButton for on-chain actions. Old owner_key/localStorage plumbing removed.
- Smoke test extended to 38 assertions: +3 auth-gated profile probes (activity/favorites/hero-moment accept 200 or 401), +1 public-profile probe (accepts 200 or 404 JSON post-greenfield), +1 opt-in authed render probe for /nba-top-shot/collection (skipped unless `SMOKE_TEST_SESSION_TOKEN` env var is present).
- Docs: `public/llms.txt` updated with Phase 1-4 feature additions; CLAUDE.md session entry added.

Key constants (Phase 4)

- follows has a `CHECK (follower_user_id <> followee_user_id)` so users can't self-follow at the DB level.
- Smoke test env: `SMOKE_TEST_SESSION_TOKEN` (optional) carries a real sb-* cookie value for the authed render probe. Generated by signing in as a test user in prod and pasting the cookie value into Vercel env.
- NBA Top Shot default UUID (used as table DEFAULT for saved_wallets.collection_id, trophy_moments.collection_id, recent_searches.collection_id): `95f28a17-224a-4025-96ad-adf8a4c63bfd`.
- All four profile tables: DEFAULT auth.uid() + RLS (user_id = auth.uid()). Service-role calls (supabaseAdmin) bypass RLS, which is how our /api/profile/* routes write; anon clients stay blocked.
- Trevor's account (15548e5c-6241-4d15-9e49-1eaed584f2a2 / tdillonbond@gmail.com) persists in auth.users — need to manually re-seed profile_bio (with username = "jamesdillonbond") + saved_wallets post-deploy to get the public `/profile/jamesdillonbond` page live again.

---

### April 10, 2026 Session

Shipped (16+ commits)

- On-chain sales indexer: NFTStorefrontV2.ListingCompleted + TopShotMarketV3.MomentPurchased events, 250-block chunks, GQL fallback via Cloudflare proxy for unknown nftIDs, dedup via transaction_hash
- Pipeline trigger endpoint: GET /api/pipeline-trigger?token= runs ingest→sales-indexer→fmv-recalc→listing-cache sequentially
- Seeded wallet pre-cache: GET /api/seed-wallet-refresh?token= — sequential cache-first refresh of all active seeded_wallets (300ms throttle, RPC-based cache count bypasses PostgREST cap, username→0x resolution). Cron-job.org schedule: every 6h (`0 */6 * * *`): https://rip-packs-city.vercel.app/api/seed-wallet-refresh?token=$INGEST_SECRET_TOKEN
- Public seeded-wallets list: GET /api/seeded-wallets (optional ?tag=power_user, ?username=jamesdillonbond)
- Historical sales backfill script: scripts/sales-backfill.mjs
- Edition metadata backfill script: scripts/backfill-edition-metadata.mjs (team_name + stub names via GQL)
- Collection page FMV coalesce fix (get_wallet_moments_with_fmv uses direct edition columns)
- Sniper: edition depth server-side filter, sub-$1 source re-tagging
- Discovery scripts: All Day (23 NFTs), Golazos (44 NFTs), UFC Strike (247 NFTs, migrated to Aptos)
- Collection adapter refactor: owned-flow-ids route accepts collection param with dynamic Cadence
- Pipeline CI: sales indexer step added between Flowty Sales and FMV Recalc
- Pipeline fixes: ask_proxy_fmv column added, editions upsert composite constraint, allday-ingest null guard
- Analytics tab: /[collection]/analytics with marketplace volume/sales dashboard
- Tier coverage: 100% (0 nulls)
- CSP fix: Google Fonts domains allowed in proxy.ts style-src/font-src

Key Constants

- event_cursor table: tracks last_processed_block for on-chain event indexing
- sales.source column: 'onchain' for chain-indexed sales, null for existing Flowty/GQL sales
- Cloudflare proxy header: X-Proxy-Secret (not x-topshot-proxy-secret)
- TopShotMarketV3 event: A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased (id, price, seller)
- NFTStorefrontV2 event: A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted (purchased, nftType, nftID, salePrice)
- Pipeline order: Ingest → Sales Indexer → FMV Recalc → FMV Backfill → Listing Cache

---

## Infrastructure IDs (required on every tool call)

- Supabase project ID: bxcqstmqfzmuolpuynti
- Vercel project ID: prj_YBJ6Utl32GfyBOIzbsp3kbshJh96
- Vercel team ID: team_YWGCVToPBJSS60NgVh8jiCFV
- GitHub repo ID: 1188272071

Both Vercel IDs are required on every single Vercel API or MCP tool call — never omit teamId.

---

## Route structure

All feature pages live at: app/(collections)/[collection]/
The layout at that level provides header, nav, and ticker — pages must NOT include standalone headers.

Active routes:
- /nba-top-shot/collection
- /nba-top-shot/packs
- /nba-top-shot/sniper
- /nba-top-shot/badges
- /nba-top-shot/sets
- /nba-top-shot/overview
- /nba-top-shot/market
- /nfl-all-day/overview
- /nfl-all-day/collection
- /share/[wallet] (shareable collection card)

API endpoints:
- /api/edition-stats
- /api/pack-roi
- /api/collection-snapshot
- /api/overview-stats

Collection registry: lib/collections.ts (8 collections defined)
Old flat routes redirect to the new nested paths.

---

## Frequently used commands

```bash
# Development
npm run dev

# TypeScript health check (use before deploying when Vercel rate-limited)
npx tsc --noEmit

# Git — always use Git Bash (MINGW64) on Windows
git status
git add -A && git commit -m "feat: ..."
git push origin <branch>

# Vercel redeploy via REST (use PowerShell Invoke-WebRequest — curl fails silently in Git Bash)
# POST https://api.vercel.com/v13/deployments
# body: {"name":"rip-packs-city","gitSource":{"type":"github","repoId":"1188272071","ref":"main"}}

# Env var writes also require PowerShell Invoke-WebRequest
# POST https://api.vercel.com/v10/projects/{projectId}/env?teamId={teamId}
```

---

## Key files to always reference

- lib/collections.ts — collection registry
- lib/cart/CartContext.tsx — cart state (addToCart: thumbnailUrl must be null not undefined)
- app/api/sniper-feed/route.ts — merges Top Shot GQL + Flowty listings
- app/api/fmv/route.ts — FMV lookup endpoint
- app/api/support-chat/route.ts — AI concierge (8 tools, Claude Sonnet)
- workers/topshot-proxy/ — Cloudflare Worker (committed but NOT yet deployed)
- .github/workflows/ — cron jobs (ingest, alerts, weekly report)

---

## Supabase schema facts (critical — verify before writing queries)

### editions table
Columns: id (uuid), external_id (text) ONLY.
No player_name, set_name, tier, or circulation_count on this table.

### fmv_snapshots table
Columns: edition_id, fmv_usd, confidence, computed_at. NO source column.
confidence is a Postgres enum fmv_confidence with UPPERCASE values: HIGH, MEDIUM, LOW.
Never use .eq("confidence", "high") — always uppercase.

Most recent FMV per edition:
SELECT DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC

### sales table
Year-partitioned: sales_2020 through sales_2026.

### badge_editions table
Has: player_name, badge_type, series_number.
Use .or() with ilike for case-insensitive player name matching. Always .trim() player names.

### flowty_transactions table
- `flowty_transactions.failure_category` is unconstrained TEXT; valid values are the `FailureCategory` union in `lib/flowty-tx-classifier.ts`. Adding a new category requires updating both the type union and at least one regex rule. Order matters in the `RULES` array — first match wins, so put more specific patterns above broader ones (e.g. INSUFFICIENT_GAS_FUNDS before INSUFFICIENT_BALANCE).
- Flow Error Code 1118 is a payer-gas error (pre-execution, transaction submission failure), distinct from in-execution Cadence errors. Categorized as `INSUFFICIENT_GAS_FUNDS`. Different remediation than DUC vault failures.

### General rules
- apply_migration for DDL; execute_sql for reads/verification
- Always query information_schema.columns before writing route handlers to confirm exact column names
- RLS check: SELECT array_agg(tablename) FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false
- health_check() RPC function is the single source of truth for platform state

---

## API contracts

### Top Shot GraphQL
Endpoint: https://public-api.nbatopshot.com/graphql
Minimal headers required. marketplace/graphql is Cloudflare-blocked server-side — do not use.
Edition key format: integer setID:playID (e.g., "84:2892")
topshotScore { points } does NOT exist — causes 422. Use tssPoints as null placeholder.
listingOrderID is the preferred field in GQL responses (shipped April 2026).
listingResourceID resolution: prefer listingOrderID, fallback to storefrontListingID.

### Flowty API
POST https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot
Required headers: Origin: https://www.flowty.io
blockTimestamp is in milliseconds.
valuations.blended.usdValue = LiveToken FMV equivalent.
4 pages = 96 listings max.
buyUrl = https://www.flowty.io/listing/{listingResourceID}

### RPC FMV API
GET /api/fmv?edition={setID:playID}[&serial=N]
POST /api/fmv (batch, up to 100)
GET /api/fmv/demo (public, no auth, 1hr cache, 5 real samples)
Returns: fmv, serialMult, badgePremiumPct, adjustedFmv, confidence, updatedAt

---

## Sniper feed specifics

File: app/api/sniper-feed/route.ts
- Merges Top Shot GQL + Flowty listings
- Parallel TS fetches with 6s withTimeout()
- Dedup by flowId; Flowty wins on conflict
- Sort by updatedAt desc, 200 max
- SniperDeal has source: "topshot" | "flowty"
- Flowty FMV fallback to Supabase when LiveToken null/zero
- Retired moments excluded
- tsCount: 0 on every call = Top Shot proxy not yet deployed (Cloudflare blocks Vercel IPs)

---

## Flow/Cadence contract addresses

- Dapper merchant: 0xc1e4f4f4c4257510
- DUC: 0x82ec283f88a62e65
- NFTStorefrontV2: 0x4eb8a10cb9f87357
- NonFungibleToken + MetadataViews: 0x1d7e57aa55817448
- FungibleToken: 0xf233dcee88fe0abe
- HybridCustody: 0xd8a7e05a7ac670c0
- DapperOffersV2: 0xb8ea91944fd51c43
- NFL All Day: 0xe4cf4bdc1751c65d
- Disney Pinnacle: 0xedf9df96c92f4595
- DapperStorageRent: 0xa08e88e23f332538

### Cadence purchase transaction rules
- Must be Cadence 1.0 syntax: auth(BorrowValue) &Account — NOT AuthAccount
- Dual-signer required: Dapper co-signer + buyer
- DUC leak check in post{} block required by Dapper co-signer

---

## Series map (on-chain UInt32 → display name)

0=Series 1 (S1), 2=Series 2 (S2), 3=Summer 2021 (Sum 21), 4=Series 3 (S3), 5=Series 4 (S4), 6=Series 2023-24 (23-24), 7=Series 2024-25 (24-25), 8=Series 2025-26 (25-26)
There is NO series=1 on-chain. Series 0 IS Series 1.

---

## AI Concierge

Claude Sonnet chat on every page via SupportChatConnected component.
Routes: /api/support-chat (5 tools), /api/support-chat/feedback, /api/support-chat/context, /api/support-report
Supabase table: support_conversations (with feedback col)
Escalations: Telegram + Resend. Rate limit: 25/hr.
Weekly cron: weekly-support-report.yml
Env vars needed: ANTHROPIC_API_KEY, RESEND_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ALERT_EMAIL
Telegram sentinel bot: @rpc_sentinel_bot, chat_id 1755958876

---

## Windows / Git Bash patching rules (CRITICAL)

- Dev environment: Windows, Git Bash (MINGW64), VS Code
- CRLF line endings silently break Node.js string-replace patches — use findIndex on split line arrays, or sed line-number targeting
- Heredocs truncate on long files — use Claude file output tool + PowerShell cp or Set-Content -Encoding UTF8
- Never use heredoc with ${{}} characters in Git Bash
- For multiline replacements: write a .js patch script that normalizes CRLF→LF before matching
- sed with 1i\ insert syntax works in Git Bash but not PowerShell
- Multi-line Python in GitHub Actions YAML run: steps causes YAML parse errors — use single-line one-liners
- curl fails silently in Git Bash for Vercel REST calls — always use PowerShell Invoke-WebRequest

---

## Vercel tool behavior

- MCP tools are READ-ONLY for env vars
- All env var writes: POST https://api.vercel.com/v10/projects/{projectId}/env?teamId={teamId} via PowerShell
- get_runtime_logs truncates at ~50 chars — use short time windows (1-2h), low limits (20-50), unfiltered
- environment: "production" required on get_runtime_logs or it returns nothing
- console.warn is NOT indexed by Vercel log search — always use console.log for diagnostics
- web_fetch_vercel_url returns cached results; tsCount: 0 in body = reliable proxy failure signal
- web_fetch_vercel_url only supports GET; preview URLs have SSO protection
- get_deployment_build_logs needs limit: 200 to get past npm warnings to actual TypeScript errors
- Redeployment after env var changes: POST https://api.vercel.com/v13/deployments with gitSource ref
- list_deployments → get deployment ID → poll get_deployment until READY (~30-38s for this project)
- Free tier: 100 deploys/day limit; rate limiting resolves after ~24h

---

## Code patterns and conventions

- Full file replacements only — never snippets or diffs
- Claude Code prompts: plain text, no markdown code blocks (optimized for iPhone copy-paste)
- proxy.ts is the correct Next.js 16 convention (not route.ts for proxies)
- Supabase client must be typed as any to avoid TypeScript errors in API routes
- generateMetadata cannot be exported from client components ("use client") — belongs in server-component layout.tsx
- useSearchParams requires a Suspense wrapper — any page using it must be wrapped
- Branch fragmentation is a recurring issue — consolidate with cherry-pick onto one canonical branch before merging

---

## Known issues / active work

Main branch is the canonical clean branch. Latest production deploy: commit f6ca38a.

1. Top Shot proxy not deployed — workers/topshot-proxy/ committed but wrangler deploy never run
   Missing env vars: TS_PROXY_URL, TS_PROXY_SECRET
   Remediation: wrangler login && wrangler deploy → wrangler secret put PROXY_SECRET → set env vars via Vercel REST → redeploy

2. Cart execution blocked — needs NEXT_PUBLIC_WALLETCONNECT_ID (register at dashboard.reown.com) + Dapper co-signer registration

3. Twitter deal bot — lib/twitter/post.ts shipped, posted_deals table exists, needs cron trigger

4. ~3,600 editions missing onchain IDs; 42 badge_editions rows with no player name

5. Sentry error capture inactive — `@sentry/nextjs ^10.47.0` is wired (sentry.client/server/edge.config.ts all reference `NEXT_PUBLIC_SENTRY_DSN`) but no DSN set in Vercel env. SDK is current; only blocker is creating a Sentry project (or locating the existing one) and pasting its DSN as `NEXT_PUBLIC_SENTRY_DSN` for production/preview/development. `Sentry.init` is gated by `enabled: NODE_ENV === "production"` and falls back to `""` when DSN is absent, so prod is silently dropping events today.

---

## Prioritized next actions

1. Deploy Cloudflare Worker proxy (restore tsCount > 0)
2. Cart execution (WalletConnect ID + Dapper registration)
3. Austin Kline FMV API outreach (demo URL live)
4. Twitter deal bot activation (add cron trigger)
5. LLC formation (Oregon, Milwaukie)
6. RPC Pro monetization ($9/month freemium gate)
7. Custom domain rippackscity.com (affects Resend + Supabase auth redirects)

---

## Architecture notes

- FMV recalc v1.5.0 live (WAP + days_since_sale + sales_count_30d)
- GitHub Actions cron every 20min calling /api/ingest with INGEST_SECRET_TOKEN sourced from repo secrets
- Watchlist + FMV Alerts: tables applied, API routes written, concierge tools added
- Collection sharing: /api/collection-snapshot + /share/[wallet] with OG image generation
- unique index on transaction_hash in sales_2026 (prevents duplicate wallet-seed rows)
- Flowty relationship: CEO Mike Levy, CTO Austin Kline — aware of and supportive of RPC
