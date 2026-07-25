# Candy MLB go-live — the authoritative flip procedure

**Written 2026-07-25 (Claude Code). All times Pacific.**
**Status: everything safe-and-reversible is SHIPPED and gated. Nothing below is done for you — every step here is Trevor's deliberate call.**

---

## TL;DR — there are THREE switches, not one, and they are independent

Prior notes said the go-live is "delete `proxy.ts:132`" while separately noting `collections.is_active` stays `false`. **Both statements were true and they are different switches.** There is also a third that nobody was tracking. Getting these confused is the main risk in this launch.

| # | Switch | Where | Kind | What it actually controls |
|---|---|---|---|---|
| **1** | `CANDY_MLB_PUBLIC` | `lib/launch-flags.ts` | **CODE** (1 line + deploy) | The `/insights/candy-mlb` **surface**: proxy un-gate (page + JSON + OG), sitemap slug, `/insights` hub card, footer link, drops `noindex`, arms the smoke check |
| **2** | `collections.is_active` | Postgres, `candy_mlb` row | **DB** (1 UPDATE) | Anon PostgREST reads of Candy `editions`/`players`/`sets`; ~11 cross-collection rollups; the public "N collections" counter; **the smoke freshness grader** |
| **3** | `published: true` | `lib/collections.ts:254` | **CODE** (1 line + deploy) | Nav, collection switcher, mobile nav, homepage cards, footer collection links, `/candy-mlb/*` tab routes, Candy **entity pages**, and the footer chain badge |

**Switch 1 alone makes the board public.** It does not require 2 or 3.
**Switch 2 is NOT needed for the board at all** — the board reads every `candy_*` view through `supabaseAdmin` (service_role, which bypasses RLS) and each view is hard-scoped to the Candy collection UUID. Verified by reading `app/insights/candy-mlb/page.tsx` and `pg_get_viewdef` on all 13 views.

---

## What I shipped (so the flip is one line, not five)

Previously go-live meant five coordinated edits in five files. That is five chances to half-ship — most dangerously, un-gating the route but leaving `robots: noindex`, publishing a board that tells Google to ignore it.

`lib/launch-flags.ts` now holds one boolean that all five consumers read:

- `proxy.ts:136` — route gate (page + `/api/public/insights/candy-mlb` + `/api/og/insights/candy-mlb`)
- `lib/sitemap-data.ts` — the `candy-mlb` sitemap slug
- `app/insights/page.tsx` — the hub card
- `app/insights/candy-mlb/layout.tsx` — `robots: noindex`
- `components/SiteFooter.tsx` — the site-wide footer link
- `app/api/smoke-test/route.ts` — the public-page smoke check

Locked in by `__tests__/candy-launch-flag-contract.test.ts`, which asserts **both** directions — flag-off yields the historical 42-entry sitemap with `noindex` on; flag-on yields 43 entries with `robots` gone.

### Verified live after deploy (commit `aa6d3ab5`, `dpl_BgBmugW6brMZ6DUaq4z6AjErN6Mm` = READY)

Confirms the prep changed nothing a visitor can see, and that the gate still holds:

| Check | Result |
|---|---|
| `/insights/candy-mlb` anon | **307 → /login** (gate holds) |
| `/api/public/insights/candy-mlb` anon | **307 → /login** |
| `/api/og/insights/candy-mlb` anon | **307 → /login** (new route correctly caught by the same gate) |
| `candy-mlb` in `/sitemap/0.xml` | **0 occurrences**; segment still 70 `<loc>` entries |
| `candy-mlb` on `/insights` hub | **0 occurrences** |
| Footer badge | **"BUILT ON FLOW"** — byte-identical to before the derivation change |
| `/api/og/default` (I changed this file) | **200, image/png, 131,319 bytes, 1200×630** — the edge-runtime registry import works |

The Candy OG card itself cannot be verified anonymously while gated (it is behind the same 307), which is exactly why its byte length and dimensions are pinned by an in-process test instead: **66,768 bytes at 1200×630**.

---

## THE PROCEDURE

### Step 1 — make the board public (CODE, ~3 min)

```
lib/launch-flags.ts:  export const CANDY_MLB_PUBLIC = false   →   true
```

Commit + push. Vercel must build a **non-docs** tip or the deploy is skipped — this is a `lib/` file, so it qualifies.

**Verify after (all must pass, anonymously — use a private window or `curl` with no cookies):**
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://www.rippackscity.com/insights/candy-mlb          # 200 (not 302)
curl -s -o /dev/null -w "%{http_code}\n" https://www.rippackscity.com/api/public/insights/candy-mlb # 200
curl -s -o /dev/null -w "%{http_code} %{content_type} %{size_download}\n" \
     https://www.rippackscity.com/api/og/insights/candy-mlb                                        # 200 image/png ~66000
curl -s https://www.rippackscity.com/insights/candy-mlb | grep -c 'noindex'                        # 0
curl -s https://www.rippackscity.com/sitemap/0.xml | grep -c 'insights/candy-mlb'                  # 1
curl -s https://www.rippackscity.com/insights | grep -c 'candy-mlb'                                # >=1
```
Then confirm the page renders real rows (not an empty state) and the Smoke Tests GHA run on that commit is green.

**Rollback:** set the flag back to `false`, push. One line, one deploy, ~3 min. No DB state to unwind.

---

### Step 2 — OPTIONAL: nav + entity pages (CODE, ~3 min)

Only if you want Candy in the collection switcher and want its edition/player/set pages to exist.

```
lib/collections.ts:254   published: false   →   true
```

**This is also what makes the footer honest.** The badge now derives from published collections' chains, so this flip turns "BUILT ON FLOW" into "BUILT ON FLOW + SOLANA" site-wide, automatically (that is the P4 fix — see below). **Until you do this, the Solana board still footer-says "BUILT ON FLOW."**

**Know before you flip:** this exposes the `/candy-mlb/*` feature tabs (collection/market/sniper/packs). Those are the Flow-shaped tabs; per `docs/handoff-2026-07-24-candy-productization.md` the "28-shared-RPC candy-arm fix" is **NOT done** — ~28 analytics RPCs have a slug-normalisation `CASE` with no `candy_mlb` arm and no `ELSE`, so Candy collapses to `NULL` on those surfaces. **Recommendation: leave Switch 3 OFF at launch.** Ship the `/insights` board first; the tabs are a separate piece of work.

**Rollback:** revert to `false`, push.

---

### Step 3 — OPTIONAL and LAST: `is_active` (DB, ~1 min)

Only if you want Candy inside the cross-collection rollups. **The board does not need this.**

**⚠ Pre-arm the smoke grader FIRST or you will red the CI gate** (see the analysis below — 2.6h of headroom against a 24h threshold).

```sql
-- 3a. FIRST: stop the freshness grader false-reddening on a thin market.
--     Candy's max observed inter-sale gap is 21.4h against a 24h fail threshold.
--     Either add candy_mlb to v_low_volume_collections in analytics_smoke_run(),
--     or accept intermittent reds. Do this BEFORE 3b.

-- 3b. THEN the flip:
UPDATE collections SET is_active = true WHERE slug = 'candy_mlb';

-- 3c. Raise the pipeline severities — their 'info'/'medium' settings are
--     justified in the notes by "candy_mlb is unpublished", which stops being
--     true here. Only critical|high can page.
UPDATE pipeline_cadence_watchlist SET severity = 'high'
 WHERE pipeline = 'candy-sales-indexer';   -- feeds the ONLY Candy price signal
```

**Rollback:** `UPDATE collections SET is_active = false WHERE slug = 'candy_mlb';` — instant, and every consumer re-filters on the next call. `sets_summary` keeps stale Candy rows until the next `refresh_sets_summary()` (07:50 UTC / 12:50a PT daily); force it with `SELECT refresh_sets_summary();`.

---

## Full `is_active` consumer analysis (verified against the live DB)

**Nothing in the TypeScript codebase reads `collections.is_active`.** All 9 `from("collections")` queries use `supabaseAdmin` (service_role, RLS-exempt) and none filters on it. Every consumer is Postgres-side — which is exactly why grep alone would have missed this.

### A. RLS policies — the highest-impact consumer, and the ordering hazard

| Table | Policy | Predicate |
|---|---|---|
| `collections` | `public_read_collections` | `is_active IS TRUE` |
| `editions` | `public_read_editions` | `collection_id IN (SELECT id FROM collections WHERE is_active IS TRUE)` |
| `players` | `public_read_players` | same |
| `sets` | `public_read_sets` | same |

`anon` holds `SELECT` on all four (verified in `information_schema.role_table_grants`), so these policies bite. **Flipping `is_active` makes Candy's 125 editions, its players and its sets readable by anyone holding the anon key — which ships in the client bundle — independent of any route gate.**

**→ This is why Step 3 goes LAST.** Flipping `is_active` before Step 1 publishes the underlying data while the page is still gated: a silent data exposure with no user-facing surface to justify it. Nothing here is secret, but the ordering should be deliberate rather than accidental.

### B. Views (2)

- **`editions_unified`** — all 3 UNION arms gated `c.is_active IS TRUE`. Sole consumer is `refresh_sets_summary()` (pg_cron jobid 37, `50 7 * * *` UTC = 12:50a PT), which populates `sets_summary` → `get_set_detail` / `get_set_editions` / `/[collection]/set/[slug]`. So Candy sets appear on set surfaces one day after the flip, not immediately.
- `v_tracked_wallet_fmv_confidence` — internal.

### C. Functions (11 confirmed via `pg_get_functiondef`)

| Function | Effect of the flip | Newly spends? | Newly pages? |
|---|---|---|---|
| **`analytics_smoke_run`** | Starts grading Candy sales + FMV freshness | no | **YES — see below** |
| `get_platform_stats` | Public "N collections" counter **5 → 6** | no | no |
| `get_market_summary` | Candy row in the market summary band | no | no |
| `analytics_liquidity_distribution` | Candy row | no | no |
| `analytics_fmv_tier_pulse` | Candy row on the FMV dashboard | no | no |
| `get_wallet_collection_stats` | A new (mostly zero) Candy row per wallet on dashboard tiles | no | no |
| `get_fmv_coverage` | Candy graded in coverage | no | no |
| `health_check` | Candy graded | no | soft |
| `dispatch_due_deal_alerts` | `candy_mlb` joins the alert slug array | no | no |
| `build_deal_alerts_for_subscription` | same | no | no |
| `build_deal_alerts_for_subscriber` | same (no repo caller — legacy) | no | no |

### D. Newly SPENDS — nothing. Verified.

The Candy board triggers **no** new Solana/Helius/Magic Eden calls on any flip. All four Candy indexers (`candy-editions-ingest`, `candy-sales-indexer`, `candy-offers-indexer`, `candy-listings-indexer`) are **hardcoded Vercel cron entries** (`vercel.json:129,133,137,141`) keyed off `CANDY_MLB_SLUG` constants, entirely independent of `is_active` and of the launch flag. All 66 live `pg_cron` jobs are hardcoded per-collection and none reads `collections`. There is no "all active collections" loop that fans out to a chain API. The page itself is ISR `revalidate=300`, so traffic cannot amplify DB load beyond one render per 5 min.

### E. Newly PAGES — exactly one, and it is a false positive waiting to happen

`analytics_smoke_run` grades sales freshness as **`fail` when `minutes_stale > 1440` (24h)**, excluding only `v_low_volume_collections := ARRAY['ufc_strike','laliga_golazos']`. **Candy is not in that list.**

Measured live:
- 192 total sales, all inside the last 7 days; 113 in the last 24h; last sale 1.9h ago
- **max observed inter-sale gap: 21.4h — against a 24h fail threshold**

That is **2.6 hours of headroom** on a market four days old, heading into a weekend. One quiet night reds the Smoke Tests gate. Hence step 3a. This matters more than it looks: per the 07-25 finding that the smoke gate was green on 3,072 consecutive runs while masking a live failure, a gate that cries wolf gets ignored — and then it is worse than no gate.

---

## P4 — "BUILT ON FLOW" on a Solana page: FIXED

The badge was a hardcoded string in `components/SiteFooter.tsx` and baked into `app/api/og/default/route.tsx`. Deleting the attribution would have been wrong — "built on Flow" is real provenance worth keeping. It is now derived: `publishedChainsBadge()` in `lib/collections.ts` names each distinct chain across published collections.

- **Today:** `"BUILT ON FLOW"` — byte-identical to before, zero visual change.
- **After Switch 3:** `"BUILT ON FLOW + SOLANA"`, automatically.
- Falls back to the historical string if the registry ever yields no known chain, so it can never render a dangling "BUILT ON".

**Caveat, stated plainly:** because the footer is mounted by shared layouts that cannot see which child route is rendering, this is a **site-wide** badge, not per-page. If you flip Switch 1 without Switch 3, the Solana board still says "BUILT ON FLOW". A truly per-surface badge would mean threading a prop through every layout that mounts the footer — more blast radius than the problem warrants.

---

## P5 — the two items

### `spread_pct` — presentation only. FIXED and shipped.

`candy_offer_spread_board.spread_pct` is `100 * (floor_ask − best_offer) / best_offer` — it divides by the **bid**, so it is unbounded. Live: of 101 rows only 17 have a value, and **all 17 exceed 200%, median 3,591%, max 24,849%** (the brief's 13,410% is now stale/low). A column of five-digit percentages reads as a broken site.

**Concluded: purely presentational.** `spread_pct` has exactly one consumer in the entire codebase — the display column at `CandyBoardClient.tsx:319`. It feeds no FMV, no pack EV, and no published price. So per the brief this was shippable, and I shipped it **client-side with no SQL touched**: the column now renders the conventional `(ask − bid) / ask`, bounded at 100%, relabelled **"Below ask"**. A $0.22 bid under a $55 ask reads "99.6%" instead of "24,849%". The raw dollar `Spread` column is untouched and remains the honest headline number. Sort order is preserved because the two expressions are monotonically related in `bid/ask`.

### `K = 10` troll ceiling — NOT shipped. Handed off, deliberately.

`K` is hardcoded `10.0` in two migrations and gates which asks are excluded from `candy_listing_floor.floor_usd`. Measured against live data (71 editions with both a floor and an FMV):

| floor ÷ FMV | count |
|---|---|
| median | **1.41×** |
| > 2× | 19 |
| > 3× | 10 |
| > 5× | 6 |
| > 10× | 2 |

**Concluded: hand off, do not ship.** Changing `K` changes `floor_usd` — a **published price** that also feeds `spread_usd` and the Deals board's `discount_pct` (i.e. which listings are advertised as underpriced). That is pricing logic, not presentation, and the standing rule is that pricing-logic edits get handed off.

**Not launch-blocking.** The guard is working — median 1.41× is healthy, and the surviving 3–7× asks are *real live asks*, disclosed in a footnote. Nothing is fabricated. Recommendation for a post-launch pass: `K = 5` (would newly exclude 6 of 71), **and update the footnote copy in the same change** — `CandyBoardClient.tsx:562` hardcodes the string ">10×", so changing `K` in SQL alone silently desyncs the UI from the guard.

---

## Part D — is the data ready? YES, with one caveat to understand

All measured live, 2026-07-25 ~7:30a PT.

| Tab | Rows | Verdict |
|---|---|---|
| Market | 125 (91 priced / **34 honest em-dash**) | Ready — 72.8% coverage, disclosed |
| Deals | 31 | Ready |
| Spread | 101 (17 with a spread) | Ready **after** the presentation fix |
| Serials | 500 | Ready |
| Scarcity | 125 | Ready |
| Holders | 248 wallets | Ready |
| Players | 100 | Ready |
| Parallel premium | **2** | Thin but correct — it is a Core-vs-Rainbow comparison, 2 rows is the whole point |
| Pack EV | 1 | Ready |

**No tab is empty or broken.** Feed freshness at time of writing: FMV 1.4 min, sales 1.9h (3h cron), offers 100 min (6h cron), listings 113 min (3h cron), 167 FMV snapshots in 24h. 249 active listings, 42 active offers. Holders 248 wallets / 6,924 serials / ~$31.6k estimated value.

**The caveat a first-time visitor must not misread:** only **6,924 of 25,375 serials (27%)** are in collector hands — 18,451 are still sealed in Candy's treasury, because only 1,000 of ~2,500 pre-minted packs have been released. Median `circulating_pct` is 26.8%. **The board handles this correctly and honestly** — the Scarcity tab is explicitly framed "sealed vs circulating", states the treasury holds most supply, and warns Drop 3 will move the number. The top-of-page banner leads with "**Early read, not a census**", names the ~Jul 23 market open, gives the exact priced/total counts, and says un-traded editions show "—".

**Drop 3 (Wed 07-29, 1,500 packs) needs nothing pre-wired.** It is a tranche of the same pre-mint, so assets stay 27,876 and editions stay 125; the daily editions cron absorbs it. Two things to watch after it lands: `assets_seen` should stay 27,876 (growth means a genuinely NEW series), and `circulating_pct` will jump as those packs open.

**My readiness verdict: the board is credible to a stranger on day one.** The one thing that would have looked broken to a first-time visitor was the Spread tab's five-digit percentages, and that is now fixed.

---

## Still open / only Trevor can do

1. **The three flips above.** Mine to prepare, his to pull.
2. **Step 3a** (smoke exclusion) must precede Step 3b or the CI gate will intermittently red.
3. **Pipeline severities** — all four Candy pipelines are `info`/`medium`, and only `critical|high` can page. Their notes justify this with "candy_mlb is unpublished." **That justification expires the moment the board is public**, regardless of which switch is used. Raising `candy-sales-indexer` to `high` should ride the launch.
4. **`K = 5`** — pricing-logic call, handed off, not launch-blocking.
5. **Internal linking:** the board renders player names as plain text, not links, so it contributes **zero** entity drill-downs. That is *correct* today — Candy entity pages 404 while `published: false` — but it means the board is an SEO dead-end until Switch 3, and the site's main SEO lever is internal linking. Wiring `playerCell` to `<Link>` should be part of Switch 3, not Switch 1.
6. **The 28-shared-RPC candy-arm fix** is still not done and gates Switch 3's tab surfaces.
7. **Pre-existing, not mine:** `npx tsc --noEmit` reports 3 errors, all in `__tests__/` files from other sessions' commits (`api-admin-analytics-smoke-deferred`, `api-backfill-onchain-ids-deep`, `api-golazos-sniper-feed-deep`). They do **not** break the Vercel build — deployments on those commits are `READY`, so Next is not typechecking test files — but a CI job that runs `tsc` over the repo would red.
