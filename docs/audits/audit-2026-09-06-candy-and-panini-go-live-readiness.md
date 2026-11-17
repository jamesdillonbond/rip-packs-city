> Subagent report from the 2026-09-06 Cowork deep-audit session (Trevor present). Read-only; every number is a dated live sample — re-measure before quoting. Actions taken on it are recorded in docs/overnight/ledger.md (2026-09-06 entries) and known-issues #59–#62.

# What it takes to flip Panini and Candy MLB to live

Read-only audit, 2026-09-06. All numbers are live samples from `bxcqstmqfzmuolpuynti` at ~16:30Z.

## 0. The framing that matters most

"Live" is **three independent switches**, not one (`docs/reference/routes-and-surfaces.md:5-28`, `docs/candy-go-live-flip-2026-07-25.md`):

| switch | where | governs |
|---|---|---|
| `*_PUBLIC` | `lib/launch-flags.ts` | the `/insights/<board>` page + JSON + OG, via `proxy.ts:288,297` |
| `published: true` | `lib/collections.ts:235` (panini) / `:255` (candy) | nav, switcher, footer, `/<slug>/*` tab routes, entity pages, footer chain badge |
| `collections.is_active` | Postgres | 4 RLS policies (`collections/editions/sets/players` anon reads), 17 functions reading `is_active`, incl. `analytics_smoke_run` grader |

**Both `*_PUBLIC` flags are already `true`** — `/insights/candy-mlb` (since 07-31) and `/insights/panini-squeeze` (since 08-01) are public and indexed. What is NOT live is switches 2 and 3. **Nothing in TypeScript reads `collections.is_active`** (verified: the only `.eq("is_active")` hits are `seeded_wallets`/`pipeline_cadence_watchlist`, not `collections`), so the DB flip is purely a Postgres-side event.

## 1. Current state

### Candy MLB (`209ade70…`, `solana`, `is_active=false`, `published=false`)

| datum | live value |
|---|---|
| `editions` | **125** |
| `edition_fmv_current` | **125 / 125 priced; 82 HIGH/MEDIUM (65.6%)** — highest share on the platform |
| `sales` (`collection='candy_mlb'`) | **6,842 total, 312 in 7d, last 2026-09-06 12:06Z** |
| `wallet_moments_cache` | **25,375 rows, 25,375 with `fmv_usd`** (the roadmap's "$0 wallet" gap is closed) |
| max inter-sale gap, 14d | **16.4 h** (vs 24 h smoke fail threshold) |

Pipelines, 7d: `candy-editions-ingest` 3/3 ok · `candy-sales-indexer` 25/25 · `candy-listings-indexer` 25/25 · `candy-offers-indexer` 12/13 · pg_cron jobs 201/248/404/436 active. All four Vercel crons in `vercel.json:124-139`. No `pipeline_alert_suppression` rows. **The Candy shared-schema data plane is complete and healthy.**

**What a user sees today:** anon → `/candy-mlb/*` 307s to `/login` (`proxy.ts:743-768` enumerate only the five Flow slugs). Signed-in allow-listed → `app/(collections)/[collection]/layout.tsx:41-63` renders the **"We're building something great for Candy MLB — check back soon"** shell. No `app/(collections)/candy-mlb/` dir exists.

### Panini (`d1a0a7f5…`, `ethereum`, `is_active=false`, `published=false`)

Two *different* Panini data planes exist, and neither lives in the shared schema:

| datum | live value |
|---|---|
| `editions` / `edition_fmv_current` / `sales` / `wmc` for `panini_blockchain` | **0 / 0 / 0 / 0** |
| `panini_editions` (side table) | **4,910**, 2,480 seen in 7d, latest 14:00Z today |
| `panini_fmv_snapshots` | 46,143 total, 2,223 in 24h |
| `panini_card_serials` | 101,424; 24,613 with `last_sale_usd` |
| `panini_coverage_summary` | **36.2% trustworthy (1,777 / 4,910)**, oldest family **1,215.7 h (50 days)** stale, 13 listing-gated families |

Pipelines, 7d: `panini-ingest` 3,668/3,668 ok (residential Windows Task Scheduler runner, `scripts/ingest-panini-runner.mjs`, invisible to Vercel/pg_cron), `panini-ingest-enum` 19/19, `panini-squeeze-mv` 152/152 (jobid 353), `thp-leg-panini` 12/12 (jobid 330).

**What a user sees today:** anon → 307 to `/login`. Signed-in → `app/(collections)/panini-blockchain/overview` and `/sniper` are **static route dirs that bypass the `[collection]` "Coming Soon" branch**. They render `PaniniOverviewClient.tsx` — an **OpenSea "paniniblockchain" bridge page** (a third plane: ERC-721 bridged cards, mostly non-sports "Bad Eggs" per `lib/collections.ts:224-228`) whose two APIs (`app/api/panini/market-stats`, `app/api/panini/listings`) **502 on every load** because `OPENSEA_API_KEY` is unset (known-issues #58). The page also carries a hardcoded `PANINI_NEWS` array (`PaniniOverviewClient.tsx:20-38`) with unverifiable claims ("Record Sales Month…", dated 2025).

## 2. Ordered go-live checklist

### Candy MLB — realistic; ~2–4 days

| # | item | kind | where | effort |
|---|---|---|---|---|
| C1 | Add `candy_mlb` arm to the **16 shared RPCs** whose slug `CASE` has `ufc_strike` but no `candy_mlb`/`ELSE` (Candy collapses to NULL): `analytics_fmv_tier_pulse, analytics_liquidity_distribution, analytics_listings_summary, analytics_sales_leaderboard, analytics_sales_summary, analytics_sets_detail/_directory/_series_overview/_summary, analytics_smoke_run, capture_institutional_wallet_snapshot, flowty_normalize_collection, get_collection_stats, get_platform_stats, get_ufc_set_progress, mcp_find_set_completion` | DB (migration + `supabase/tests` pins; push-gated) | `supabase/migrations/` | 1 day |
| C2 | Add `candy_mlb` to `v_low_volume_collections` in `analytics_smoke_run()` (currently `ARRAY['ufc_strike','laliga_golazos']`), or the 24 h freshness grader will intermittently red CI (16.4 h max gap observed) | DB | same migration as C1 | 0.5 h |
| C3 | Chain-dispatch the tab pages Candy's `pages: ["overview","collection","packs","sniper"]` would expose. **Zero** `candy|solana` references in `app/(collections)/[collection]` or `components/collection`. `/collection` wallet-paste → Flow Cadence; `/sniper` → `/api/sniper-feed` (Flow listings, Candy asks live in `candy_listings`); `/packs` → Flow packs. `app/api/wallet-backfill-candy/route.ts` exists but has **no caller**. Options: (a) trim `pages` to `["overview"]` and make overview embed/link the existing board; (b) build Candy arms. | CODE + PRODUCT-DECISION | `lib/collections.ts:253`, `app/(collections)/[collection]/{collection,sniper,packs}` | (a) 0.5 day · (b) 3–5 days |
| C4 | Add `candy-mlb` to the two anon-public regexes (`proxy.ts:751,768`) and to `PUBLIC_READ_APIS` for whatever APIs C3 uses; update `__tests__/public-wallet-surface-contract.test.ts` | CODE (auth file — off-limits to the night pass) | `proxy.ts` | 0.5 day |
| C5 | Flip `published: true`; footer badge auto-becomes "BUILT ON FLOW + SOLANA"; sitemap gains `/candy-mlb/*` via `lib/sitemap-data.ts:694`; update the sitemap-count assertions in `candy-launch-flag-contract` / `api-smoke-test-deep` | CODE | `lib/collections.ts:255` | 0.5 day |
| C6 | Media: all 125 Candy editions carry arweave `video_url`; `proxyIpfsUrl()` passes non-IPFS URLs through unchanged and the CSP refuses `arweave.net` (ledger 09-05, 09-04). Do NOT add `candy_mlb` to `VIDEO_ENABLED_SLUGS` without a proxy/CSP fix | CODE | `lib/entity-editions-grid-format.ts`, `lib/ipfs-media.ts:28` | 0.5–1 day |
| C7 | Wire board `playerCell` to `<Link>` (entity pages become real after C5) | CODE | `app/insights/candy-mlb/CandyBoardClient.tsx` | 1 h |
| C8 | `UPDATE collections SET is_active=true WHERE slug='candy_mlb'` — **last**, after C1/C2. Rollback is the inverse UPDATE; `sets_summary` lags until `refresh_sets_summary()` (jobid 37) | DB | — | 5 min |
| C9 | Verify anon renders (DOM, not 200), `get_platform_stats` shows 6, Smoke GHA green over one weekend | verification | — | 0.5 day |

### Panini — not realistic as a shared-schema collection today; gate on a product decision

| # | item | kind | effort |
|---|---|---|---|
| P0 | **PRODUCT-DECISION: which Panini is "the collection"?** The registry (`openSeaSlug: "paniniblockchain"`, `dbChain: "ethereum"`, `marketplaceWalletUrl → opensea.io`) describes the OpenSea bridge plane. The data you actually have (4,910 editions, 46k FMV rows) is the WC Prizm plane from `nft.paniniamerica.net`, a **private Sawtooth chain** with no wallet concept RPC can index (`lib/collections.ts:224-228`). `is_active=true` on a row with **0 `editions`** makes every cross-collection rollup show a Panini row of zeros — the honesty canon's fabricated-number shape. | Trevor | — |
| P1 | If WC Prizm: bridge `panini_editions`/`panini_fmv_snapshots` → `editions`/`fmv_snapshots` (schema mapping, `external_id` psku, tiers), then C1-style RPC arms; disclosure of 36.2% listing-gated coverage must travel to every surface | DATA-BACKFILL + DB + CODE | 1–2 weeks |
| P2 | If OpenSea bridge: set `OPENSEA_API_KEY` (#58), then either delete `PANINI_NEWS` or source it; the plane has no editions/FMV pipeline at all — that would be net-new | SECRET + CODE | key: 5 min · pipeline: 1–2 weeks |
| P3 | Either way: `panini-ingest` severity `info→medium/high` (note says "RAISE AT GO-LIVE" and was missed 08-01), Task-Scheduler runner drops ~15% of ticks by design | DB + Trevor (pages his own box) | 10 min |
| P4 | `published`/`proxy.ts`/sitemap steps mirror C4–C5 | CODE | 1 day |

## 3. Needs Trevor

1. **`OPENSEA_API_KEY` in Vercel (all 3 envs) + redeploy** — only gates the OpenSea overview/sniper pages, not the squeeze board (#58).
2. **P0** — which Panini plane, if any, becomes the collection.
3. **C3 (a) vs (b)** — thin Candy tabs vs full chain-dispatched tabs.
4. Whether `panini-ingest` severity may page his residential box.
5. The `published` flips themselves — `lib/launch-flags.ts:22` says public-exposure flips are his call; the tagline rule ("Flow… until chain two ships visible product") flips with C5.

## 4. Risks

- **Panini `is_active=true` today = zeros everywhere**: `get_platform_stats` "6 collections", `get_market_summary`/`analytics_*` Panini rows at 0, `get_wallet_collection_stats` a $0 Panini tile per wallet, `get_fmv_coverage` 0/0. Every one is a read that succeeded and rendered nothing — which reads as a fact.
- **Candy `published=true` without C3 = Flow tabs on a Solana collection**: wallet paste fails or silently returns 0 moments; sniper empty (asks are in `candy_listings`, not the Flow feed). With C1 undone, ~16 RPCs return NULL for Candy on analytics surfaces.
- **Smoke CI red on a quiet night** without C2 (2.6 h→7.6 h headroom now, still under one weekend).
- **RLS exposure order**: `is_active` before `published` publishes 125 editions via the anon key with no surface — harmless but deliberate-order matters.
- **SEO**: C5 adds `/candy-mlb/{overview,collection,packs,sniper}` + entity pages to the sitemap; each must render real rows or return honest degraded state (`summarizeDegraded`), never `—` grids masquerading as empty markets. Panini's 50-day-stale families and 36.2% coverage must stay disclosed on any new surface.
- **Media**: Candy arweave video breaks under CSP the moment `VIDEO_ENABLED_SLUGS` gains the slug (C6).
- **Two-vocabulary footgun**: `flowty_normalize_collection` has no Candy/Panini arm; harmless today because neither has Flowty rows, but the CHECK on `flowty_transactions` will reject any future write.

## 5. Bottom line

**Candy MLB can go fully live in roughly one focused week** — data plane is done (125/125 priced, 65.6% HIGH/MED, 6,842 sales, wallets priced); the work is 16 RPC arms, the smoke exclusion, `proxy.ts`, and a decision on how much tab surface to ship. **Panini cannot be flipped honestly at all until Trevor picks a plane**: the registry points at OpenSea (needs the key, has no editions pipeline), the data lives in `panini_*` side tables that never touch `editions`, and the shared-schema row would light up as a collection of zeros.