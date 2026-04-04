# Rip Packs City — Claude Code AI Assistant Configuration

## Project overview

Rip Packs City (RPC) is a production-grade NBA Top Shot collector intelligence platform competing directly with LiveToken. It targets serious collectors with analytics, deal-finding, sniper tools, FMV pricing, and badge tracking. Trevor (founder) holds an official Portland Trail Blazers Team Captain designation on NBA Top Shot — a key brand differentiator.

Stack: Next.js 16 App Router, React 19, TypeScript 5, Tailwind 4, @onflow/fcl, Supabase, Vercel.

Live: https://rip-packs-city.vercel.app
Repo: github.com/jamesdillonbond/rip-packs-city (public)

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

## Series map

0=Beta, 1=S1, 2=S2, 3=S3, 4=S4, 5=S5, 6=S6, 7=S7, 8=S8

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
- GitHub Actions cron every 20min calling /api/ingest with INGEST_SECRET_TOKEN=rippackscity2026
- Watchlist + FMV Alerts: tables applied, API routes written, concierge tools added
- Collection sharing: /api/collection-snapshot + /share/[wallet] with OG image generation
- unique index on transaction_hash in sales_2026 (prevents duplicate wallet-seed rows)
- Flowty relationship: CEO Mike Levy, CTO Austin Kline — aware of and supportive of RPC
