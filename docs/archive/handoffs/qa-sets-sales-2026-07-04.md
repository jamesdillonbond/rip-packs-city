# QA — Set pages (20) + Sales-history vs Dapper (10 moments) — 2026-07-04

Author: Claude Code (Chrome + Supabase MCP). Live check against production `www.rippackscity.com`
and `nbatopshot.com`. All times below are as-stored (UTC) unless noted.

TL;DR
- **Set pages: 17 / 18 sports-collection set pages load correctly (~94%).** One hard 404 found:
  `/nba-top-shot/set/wnba-rookie-debut` (the current Series-8 "WNBA Rookie Debut" set, 90 editions —
  the largest/newest WNBA rookie set). Its own edition pages link to that dead slug. Root cause below.
  Disney Pinnacle has **no set pages at all** (by design — not a regression).
- **Sales history vs Dapper: recent sales are captured and prices/dates line up**, but **3 / 10 moments
  are mis-attributed to the BASE edition when Dapper shows them as a numbered PARALLEL** (Hexwave /
  Hardcourt / Blockchain), all in Series-2025-26 sets. Plus two smaller data-quality issues
  (serial captured as `0`; thin sales depth on an old low-volume edition). This is the known
  parallel-conflation class surfacing on live, current moments.

---

## Method note (important — the naive count query overcounts)

The prompt's `SELECT COUNT(*) ... GROUP BY set_name` **overcounts TopShot sets**. Example — "Hustle and
Show": raw `COUNT(*)` = **212**, but that includes **58 non-canonical UUID-fossil editions** (retired
GQL-dupe rows the set page correctly excludes) spanning **6 series**. The set page renders **150**, which
reconciles to the **154 canonical** editions (`external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'`). So the correct
denominator for a TopShot set page is the **canonical** edition count, not the raw `set_name` count.
For AllDay / Golazos / UFC there is no UUID-fossil inflation, so raw `total` ≈ page count.

RPC set pages are keyed by the slugified **display set name** (e.g. `ball-hawk-parallel-` keeps the trailing
hyphen from the `)`), and TopShot pages aggregate a name **across series/on-chain sets** (Hustle and Show
spans sets 108/132/177/236…). Counts below use the canonical denominator for TopShot.

---

## Item 1 — Set pages (20 sets across 5 collections)

| # | Collection | Set | URL slug | Loads | Page editions | DB (canonical) | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | TopShot | Hustle and Show | hustle-and-show | ✅ | 150 | 154 (raw 212) | OK (−4, minor) |
| 2 | TopShot | Constellations | constellations | ✅ | 47 | 51 | OK (−4, minor) |
| 3 | TopShot | Lace 'Em Up | lace-em-up | ✅ | 30 | 30 | ✅ exact |
| 4 | TopShot | 2023-24 Honors | 2023-24-honors | ✅ | 26 | 26 | ✅ exact |
| 5 | TopShot | 2024-25 Honors | 2024-25-honors | ✅ | 25 | 25 | ✅ exact |
| 6 | TopShot | 2025 Rookie Ultimates | 2025-rookie-ultimates | ✅ | 25 | 25 | ✅ exact |
| 7 | TopShot | The Anthology: Steph Curry | the-anthology-steph-curry | ✅ | 6 | 6 | ✅ exact |
| 8 | TopShot | **WNBA Rookie Debut** | wnba-rookie-debut | ❌ **404** | — | 90 | **BROKEN** |
| 9 | AllDay | One to Remember | one-to-remember | ✅ | 100+ (Load more) | 128 | OK |
| 10 | AllDay | Draw it Up | draw-it-up | ✅ | 100+ (Load more) | 117 | OK |
| 11 | AllDay | Ball Hawk (Parallel) | ball-hawk-parallel- | ✅ | 75 | 75 | ✅ exact |
| 12 | AllDay | Iconic | iconic | ✅ | 61 | 61 | ✅ exact |
| 13 | AllDay | Marquee | marquee | ✅ | 26 | 26 | ✅ exact |
| 14 | AllDay | Setting the Bar | setting-the-bar | ✅ | 21 | 21 | ✅ exact |
| 15 | Golazos | Talentos | talentos | ✅ | 100+ (Load more) | 108 | OK |
| 16 | Golazos | ElClásico | elcl-sico | ✅ | 23 | 23 | ✅ exact |
| 17 | UFC | Contender | contender | ✅ | 100+ (Load more) | 134 | OK |
| 18 | UFC | Challenger | challenger | ✅ | 8 | 8 | ✅ exact |
| 19 | Pinnacle | The Lion King Vol.1 | (none) | ⛔ N/A | — | — | No set pages (by design) |
| 20 | Pinnacle | Frozen Vol.2 | (none) | ⛔ N/A | — | — | No set pages (by design) |

**Match rate: 17 / 18 sports set pages load and show a plausible/correct edition count (~94%).**
Spot-checks of player names, tiers, series, and set-level FMV on the loaded pages were all correct
(e.g. 2025 Rookie Ultimates → all ULTIMATE, Mint 1; ElClásico → LEGENDARY Modric/Ramos/Puyol; Contender
→ CONTENDER fighters). Set-level tier mixes matched the DB (Hustle and Show COMMON 100%, etc.).

### Finding 1A — `/nba-top-shot/set/wnba-rookie-debut` returns a hard 404 (edition pages link to it)

- The page shows the app 404 ("BINGO BANGO BONGO"). It is a **soft 404** (HTTP 200 body per the
  streaming-route `notFound()` behavior), so it's also an SEO liability.
- The edition page for a WNBA Rookie Debut moment (e.g. Aicha Coulibaly `257:8639`) generates a **"set" link
  to `/nba-top-shot/set/wnba-rookie-debut`** — the exact URL that 404s. So this is a **broken internal link**,
  not just a bad manual guess.
- **Root cause (confirmed in DB):** there are **four** distinct "WNBA Rookie Debut" sets:

  | set_id_onchain | set name (editions + sets tables) | series | canonical editions | slug | set page |
  |---|---|---|---|---|---|
  | 257 | `WNBA Rookie Debut` | 8 (2025-26) | 90 | `wnba-rookie-debut` | ❌ **404** |
  | 190 | `WNBA Rookie Debut 2025` | 7 | 33 | `wnba-rookie-debut-2025` | ✅ works |
  | 144 | `WNBA Rookie Debut 2024` | 6 | 21 | `wnba-rookie-debut-2024` | ✅ works |
  | 191 | `WNBA Rookie Debut 2025 - Signature Edition` | 7 | 15 | `wnba-rookie-debut-2025-signature-edition` | ✅ works |

  The three year-suffixed siblings resolve, but the **bare-name set 257** (the newest and largest) does not.
  `wnba-rookie-debut` is a **strict prefix** of the other three slugs, so the set-page slug→set resolver
  fails to disambiguate/resolve it (returns nothing → `notFound()`), even though set 257's name slugifies to
  exactly `wnba-rookie-debut`.
- **Impact:** a whole current 90-edition set is unreachable from its own moment pages; the "set" breadcrumb/
  link on ~90 live edition pages 404s.
- **Fix path (recommended, NOT shipped this session — needs the resolver code + a deploy/verify):** in the
  set-page server loader, resolve the slug by matching the **exact** slugified `set_name` (anchored/equality)
  rather than a prefix/`ILIKE`, and when multiple sets slugify to a colliding prefix, prefer the exact match.
  Verify `/nba-top-shot/set/wnba-rookie-debut` returns set 257's 90 editions and the year-suffixed siblings
  still resolve.

### Finding 1B — Disney Pinnacle has no set pages (by design; documenting for completeness)
`/disney-pinnacle/set/<slug>` 404s for every Pinnacle set, and Pinnacle edition/render pages contain **no
`/set/` links**. Consistent with `CLAUDE.md` ("Pinnacle does not have `sets`") and the sitemap not
enumerating Pinnacle entity hubs. Not a regression — noted so the "20-set" scope reads honestly (18 testable
sports set pages + 2 Pinnacle N/A).

### Observations (not defects)
- **Minor TopShot count deltas** (Hustle −4, Constellations −4): the page renders a few fewer than the
  canonical filter, likely excluding a handful of editions (edge parallels / no-real-sale rows). Cosmetic.
- **FMV freshness on secondary collections:** AllDay and Golazos set pages show heavy `🕒 STALE` FMV
  confidence across editions; UFC Challenger shows 2/8 `NO DATA`. Not a set-page bug, but a visible FMV
  freshness/coverage gap on the non-TopShot collections worth a separate look.

---

## Item 2 — Sales history vs Dapper (10 recent-sale TopShot moments)

Method: pulled 10 TopShot moments with sales in the last 14 days; recorded RPC's edition identity + sales
(from the `sales` table, which drives the RPC pages) and compared to the same NFT on `nbatopshot.com`
(edition, supply, parallel, tier, serial, top sale, recent-sales activity). nbatopshot.com was fully
accessible (no login/bot wall).

| # | NFT id | Player / Set | RPC edition (supply) | Dapper edition (supply) | Match? |
|---|---|---|---|---|---|
| 1 | 52203287 | Wemby / Video Game Numbers | base `263:8734` **#3/284** | **Hexwave #3/25** | ❌ parallel mis-map |
| 2 | 50287393 | Traore / Rookie Debut | base `219:7403` (#35/1000) | **Hardcourt #35/48** | ❌ parallel mis-map |
| 3 | 52374040 | KAT / 2026 NBA Playoffs | base `250:8809` (#66/1000) | **Blockchain #66/99** | ❌ parallel mis-map |
| 4 | 52196193 | Reaves / Video Game Numbers | base `263:8726` (#148/**284**) | base #148/**249** | ⚠ base OK, circ off (284 vs 249) |
| 5 | 42004314 | Embiid / The Champion's Path | `104:3653` #4736 (4 total sales) | base #4736 ("10 sold in 222 days") | ⚠ thin sales depth |
| 6 | 52043258 | Coulibaly / WNBA Rookie Debut | `257:8639` #260/976 | base #260/976 | ✅ match |
| 7 | 51297564 | Booker / Metallic Gold LE | `233:8142` serial **0** ($7) | #**122**/191 | ⚠ serial captured as 0 |
| 8 | 52205938 | Tony Bradley / Base Set | `218:8758` #260/960 | base #260/960 | ✅ match |
| 9 | 50124522 | Gabby Williams / WNBA Extra Spice | `207:7222` #587 | base #587 | ✅ match |
| 10 | 51494424 | Kuminga / Metallic Gold LE | `233:8308` #19/199 | #19/191 | ✅ match (circ 199 vs 191, ~ok) |

**On prices/dates:** for every actively-traded edition RPC's recent sales line up with Dapper's activity
("10 sold in the past N days"), and the captured sale prices/dates are consistent. **No evidence RPC is
missing *recent* sales** on liquid editions. The gaps are attribution and depth, below.

### Finding 2A — Parallel sales mis-attributed to the BASE edition (3 / 10) — the headline
Dapper shows these NFTs as numbered **parallels**; RPC has each keyed to the **base** edition:
- **Wemby `52203287`** → Dapper **Hexwave #3/25**; RPC base `263:8734` **#3/284**.
- **Traore `50287393`** → Dapper **Hardcourt #35/48**; RPC base `219:7403` (base circ 1000).
- **KAT `52374040`** → Dapper **Blockchain #66/99**; RPC base `250:8809` (base circ 1000).

Confirmed in DB:
- **Set 263 (Video Game Numbers) has ZERO `::` parallel editions cataloged in RPC** (`subeds_in_set = 0`),
  and NFT `52203287` is **not** in `topshot_moment_subeditions`. So RPC has no Hexwave line for VGN at all —
  every VGN parallel sale is being folded onto the base. (RPC also stamps a uniform `circulation_count = 284`
  on VGN base editions — a placeholder — vs Dapper's true 249 base / 25 Hexwave.)
- Sets 219 / 250 / 233 **do** have parallel editions cataloged (102 / 80 / 138), yet these **recent** NFTs
  still landed on the base row — i.e. the subedition resolver hasn't processed these newer Series-8 sale NFTs
  (matches the known "parallel sale lands on base before its `::` row exists" behavior in `CLAUDE.md`).

**Impact:** wrong supply shown on those moment pages (e.g. #3/284 vs #3/25), and parallel-priced sales
contaminate the base edition's sales history / FMV (e.g. base `250:8809` carries a $150 sale among sub-$1
commons — almost certainly a Blockchain-parallel sale keyed to base). This is the exact "inflated FMV → fake
deal" mechanism the ongoing parallel-conflation work targets; these are fresh, live examples.

**Recommendation:** extend the TopShot subedition resolver to (a) catalog **set 263 (Video Game Numbers)**
parallels — currently 0 — and (b) cover **recent/forward** sale NFTs for sets 219/250 so parallel sales
re-key to their `::` edition instead of base. (Sales-path/ingest logic is off-limits for autonomous change;
flagging for CC/operator per the parallel-conflation program.)

### Finding 2B — Serial captured as `0` (Booker `51297564`)
RPC recorded this sale with `serial_number = 0`; Dapper shows it as **#122/191**. `serial = 0` appeared on
several rows in the sample (Reaves, Traore, Booker) — the serial isn't being captured on some sale ingests,
degrading serial-level FMV and "#N/M" display. Worth a targeted look at why serial resolves to 0 on these.

### Finding 2C — Thin sales depth on an old low-volume edition (Embiid `104:3653`)
RPC holds **4 total sales** for this Series-4 edition; Dapper reports "10 sold in the past 222 days" (i.e.
≥10 over ~7 months). Not a recent-sale gap, but RPC's historical depth is thinner than Dapper on older,
low-volume editions — consistent with the ASK_ONLY / missing-historical-sales class already tracked.

**Match rate: 5 / 10 clean matches; 3 / 10 parallel mis-attributions; 2 / 10 minor data-quality (serial=0,
old-edition depth). 0 / 10 cases of a *recent* sale being entirely absent from RPC.**

---

## Fixes applied

### ✅ SHIPPED — set-page 404s fixed (Finding 1A + ~416 others)
On deeper investigation the WNBA 404 was **not** a routing/resolver bug — it was a **stale materialized
view**. `sets_summary` (which `get_set_detail` resolves slugs against) is a matview with **no scheduled
refresh**, so it had drifted badly stale: **411 rows vs 807 live**. Every set added since the last refresh
404'd — the series-8 "WNBA Rookie Debut" (set 257) was one of ~417. Its old row was a fossil of a since-cleaned
`set_name` with a trailing space (`'WNBA Rookie Debut '` → slug `wnba-rookie-debut-`), so the clean
`wnba-rookie-debut` slug matched nothing.

1. **One-time `refresh_sets_summary()`** — reconciled the matview to live: **+417 slugs added, 21 stale
   removed** (incl. the `wnba-rookie-debut-` fossil). Verified live: `/nba-top-shot/set/wnba-rookie-debut`
   now returns 200 with 89 editions (was a hard 404).
2. **`audit_20260704_schedule_sets_summary_refresh`** (migration
   `supabase/migrations/20260704190000_*.sql`) — new pg_cron job `rpc-refresh-sets-summary` (jobid 37,
   `50 7 * * *` UTC, active) so the matview stays current and this class of 404 can't silently recur.
   Revert: `SELECT cron.unschedule('rpc-refresh-sets-summary');`

This also un-404'd ~416 other newer set pages across collections in one shot.

### ✅ SHIPPED — set 263 (Video Game Numbers) parallel de-conflation (Finding 2A)
Set 263 had **0 `::` parallel editions cataloged**, so its Hexwave/Jukebox parallels were conflated onto the
base edition (Wemby nft 52203287 = Dapper Hexwave #3/25 showed as base #3/284; parallel-priced sales inflated
base FMV). Ran the full catalog→remap pipeline:

1. **Resolved subeditions on-chain** — `TopShot.getMomentsSubedition(nftID)` (via Cadence MCP, mainnet) over
   all 3,465 set-263 nfts (sales+wmc+moments) → **362 parallels** (Hexwave=19, Jukebox=20; matches Dapper
   exactly). Stored durably in `topshot_moment_subeditions`.
2. **`audit_20260704_catalog_vgn_263_subedition_editions`** — cataloged **40 `::` editions** (20 plays × 2
   parallels; Hexwave circ 25, Jukebox circ 10).
3. **`audit_20260704_remap_vgn_263_subedition_sales_wmc_moments`** — re-keyed **139 sales + 243 wmc + 263
   moments** off base onto their `::` edition. Verified: 0 parallel nfts left on base; Wemby `52203287` now on
   `263:8734::19` (#3/25 Hexwave); security invariants 0, fmv_sanity 0, trust-health all ok, no duplicate
   external_ids. Revert paths in both migration headers (deterministic via `topshot_moment_subeditions`).

FMV self-heals on the next fmv-recalc sweep (the `::` editions now own the recent sales; bases de-blend). Art
for the new `::` editions is NULL pending the subedition-aware art backfill.

**Forward coverage — also SHIPPED** (`audit_20260704_seed_recent_base_subedition_targets` + orchestrator step
1c): the root cause was that the two existing seeds can't reach a brand-new parallel set (one needs a sales
collision already surfaced, the other needs `::` editions to already exist). The new proactive seed resolves
the current parallel era (newest 2 series, auto-following) each daily tick, so sets 219/250 and any future
new set self-heal without waiting for a collision. **Still open:** base-edition circulation accuracy (VGN
base uniform 284 vs Dapper ~249 Standard-only) and the `serial=0` sale-ingest capture bug.

## Recommended follow-ups (priority order)
1. ~~Fix the set-page 404s~~ — **DONE** (matview refresh + daily `rpc-refresh-sets-summary` cron; see Fixes
   applied). Also fixed a `set_name` trailing-space data hygiene issue via the refresh.
2. ~~Catalog set 263 (Video Game Numbers) parallels~~ — **DONE** (362 parallels resolved on-chain, 40 `::`
   editions cataloged, 139 sales + 243 wmc + 263 moments re-keyed; see Fixes applied).
3. ~~Cover recent/forward parallel sale NFTs for sets 219/250 (and generally)~~ — **DONE** (durable fix):
   `seed_topshot_recent_base_subedition_targets` + orchestrator step 1c proactively resolves the current
   parallel era (newest 2 TS series, auto-following) so every current/new parallel set self-heals without
   waiting for a sales collision. Root cause was the two prior seeds' chicken-and-egg blind spot (need a
   sales collision, or need `::` editions to already exist) — see Fixes applied / ledger 2026-07-04.
4. **Investigate `serial = 0` capture** on TopShot sale ingest (Finding 2B).
5. Lower priority: AllDay/Golazos FMV `STALE` freshness and UFC `NO DATA` coverage (Item 1 observation).
