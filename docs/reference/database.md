<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

# Supabase / Postgres reference

> Collection UUIDs and the two collection-string vocabularies stay in CLAUDE.md (small, stable, used constantly). Everything else lives here.

### editions table (36 columns — verified live 2026-08-14; 32 on 2026-07-16, + `description` 2026-08-12, + the three player-bio columns 2026-08-14)

Columns: id (uuid), external_id (varchar), collection_id (uuid), player_id (uuid), set_id (uuid), name (varchar), tier (enum), series (smallint), edition_kind (enum), circulation_count (int), badges (text[]), reward_indicators (text[]), thumbnail_url (text), video_url (text), play_type (varchar), play_category (varchar), game_date (date), home_team (varchar), away_team (varchar), first_minted_at (timestamptz), last_updated_at (timestamptz), created_at (timestamptz), updated_at (timestamptz), set_id_onchain (int), play_id_onchain (int), collection (text), player_name (text), set_name (text), team_name (text), **jersey_number (smallint)**, **subedition_id (smallint)**, **subedition_name (text)**, **description (text)**, **player_birthdate (date)**, **player_birthplace (text)**, **player_draft_year (smallint)**. ⚠ **Those last two types were WRONG here until 2026-08-15** — this list said `player_birthdate (text)` and `player_draft_year (int)`. Live and the recovered DDL both say **`date`** and **`smallint`**, so a session writing a date predicate or a TS type off the old line would have got both wrong. Verified against `information_schema` while recovering the migration file (D31).

The three `player_*` bio columns (added 2026-08-14) come from the same Top Shot catalog walk as `description` and cover almost exactly the same rows — measured 2026-08-15 after the first cron tick that carried them: **9,082 / 9,082 / 9,037 of 13,208** canonical Top Shot editions against `description`'s 9,128. ⚠ **They are on `Play.stats` (PlayStats), NOT on `Play` — unlike `description`**, which is the mirror image of the trap that shipped a 422 in August; get either one on the wrong type and the WHOLE query is invalid, Top Shot answers HTTP 422, and the walker completes reporting `ok: true` having written nothing. Values are sentinel-normalized through `isSentinel()` (`draftYear: 0`, `"N/A"` → null), so a NULL means genuinely absent, never a placeholder.

⚠ **They feed `lib/serials/fun-patterns.ts` and NOTHING ELSE — and for the first two hours they existed they fed nothing at all.** `classifySerial` can only emit its `jersey_match` / `birthday_match` / `draft_year_match` quirks when a caller passes the context, and both callers were passing only `circulationCount`, so three of its eleven quirk kinds were **structurally unreachable in production** however correct the pure function was. **Wiring a capability to its data is a separate act from shipping either one** — this repo has now paid for that lesson twice in two days (the concierge did not reach the new catalog search for free either). The concierge tool is wired (`find_quirky_serials`, via a chunked `editions` lookup keyed on the wallet's `edition_key`s, fail-soft so a bio-read failure degrades to serial-only quirks). **`MomentDetailModal` is wired too as of 2026-08-14** (this bullet said "is NOT wired" until then), so all eleven kinds are now reachable on both surfaces — but by a DIFFERENT mechanism, and the difference is the point. The modal fetches the bio **lazily on open** from `/api/entity/edition?part=bio&editionKey=…`, rather than threading it through the wallet-moments and sniper-feed queries: the collection table routinely holds hundreds of rows and a collector opens one, so a per-row join pays for bio nobody sees. ⚠ **That arm is keyed on `editionKey` (= `editions.external_id`), NOT on the route slug every other `part` uses** — `get_edition_detail` returns `route_slug` and `external_id` as separate fields and they are not interchangeable. It is scoped by `collection_id` because `external_id` is not unique across collections, it caches (a bio is a catalog fact, not a price), and a failed read is an ERROR rather than three nulls — all-null is exactly what an edition genuinely without a bio returns, so publishing it on an outage would make the two indistinguishable. The client half is fail-soft in the other direction: any failure leaves the serial-intrinsic chips standing, because **a missing chip understates, which is the safe direction** for a claim like "this serial is their jersey number".

`description` (added 2026-08-12) is the upstream prose the moment page renders — the ONLY narrative text in the catalog and what makes a query like "game winner" answerable. ⚠ **It comes from Top Shot `play.description`, NOT `play.stats.description`** — putting it inside `stats { }` makes the WHOLE GraphQL query invalid, Top Shot answers HTTP 422, and `backfill-topshot-catalog` completes reporting `ok: true` having upserted ZERO editions. That regression shipped and was caught only because `gql_calls` exactly equalled `sets_processed` (one call per set = every call died on its first page; a healthy walk needs multiple pages).

⚠ **The reason that was invisible is fixed, and the fix is the transferable part (`9909f27d`, 2026-08-13).** `fetchEditionsPage` returned `… | null`, collapsing **"this set has no editions"** and **"we could not ask"** into one value — so a total upstream refusal was indistinguishable from an empty catalog, and the walk logged `ok: true`. It now returns a discriminated `PageFetch` carrying a **fault string** (HTTP status + body, or the GQL error message — for a malformed query the upstream body NAMES the offending field, which was being thrown away), `walkSet` propagates `fault` alongside `editions`, and a new **`sets_faulted`** counter lands in the `pipeline_runs` extra + the HTTP payload. ⚠ `ok` deliberately does NOT redden on a SINGLE fault — Top Shot GQL is intermittently flaky and a chronically-red pipeline trains the operator to skim past it, the exact cost this repo already paid with `ufc_fmv_stale_hours`; it reddens on an upsert error or on **every** walked set faulting, which cannot be upstream noise. **Read `editions_upserted` / `sets_faulted`, never the HTTP status** — a sweep that upserted nothing still returns 200.

⚠ **The cost of that correct decision: NO instrument reads `sets_faulted`, so the fault rate can drift from 4% to 100% and only `editions_upserted` flattening would ever show it.** Filed, not fixed: [inbox 2026-08-14T2300Z](../../docs/overnight/inbox/2026-08-14T2300Z-topshot-catalog-walk-faulted-11-sets-and-nothing-watches.md). **The fault set is STABLE, not flaky** — re-verified live 2026-08-14: the 08-14 and 08-15 02:12Z ticks are **byte-identical** at `editions_upserted 9396 / sets_processed 258 / gql_calls 541 / sets_faulted 11`, two independent runs a day apart. That matters before anyone builds a retry: a stable 11 is a catalog property (11 sets whose `searchSetPlays` refuses), not transient GQL flakiness, so a blind retry loop would burn calls and change nothing. ⚠ **Measure it from `pipeline_runs` within ~73 h or not at all** — the `errors_sample` set ids that would identify WHICH 11 are pruned with the row, and `pipeline_runs_daily` does not carry them. The same query also shows the 422 regression's signature preserved on the 2026-08-12 row (`editions_upserted 0`, `gql_calls 257` == `sets_processed 257`), which is the cleanest available example of that tell.

**It is now ON A CRON (supersedes the "on no cron" note in the dated Aug-12/13 entry):** Vercel cron `12 2 * * *` → **`/api/cron/topshot-catalog-backfill`**, a thin wrapper, because `/api/admin/backfill-topshot-catalog` is guarded by `verifyAdminRequest` which accepts ONLY `RPC_ADMIN_TOKEN` while Vercel cron injects `CRON_SECRET` — a direct `vercel.json` line would have 401'd every tick, and **a 401 writes no `pipeline_runs` row, so it looks exactly like "never scheduled"** (the same invisible-failure shape as the 08-11 gate-key outage, and the trap that killed the old `pinnacle-sync` entry). The wrapper takes the canonical **dual secret** (`CRON_SECRET` or `INGEST_SECRET_TOKEN`) and calls the admin handler **in-process** rather than self-fetching — a self-fetch needs a correct absolute base URL in every environment, burns a second lambda, and fails closed on SSO-protected previews. It logs nothing itself; the walker writes its own `pipeline_runs` row (`topshot-catalog-backfill`), and two rows per tick would double-count.

The last three were added with the parallel/subedition + jersey-match work: `jersey_number` drives the JERSEY-MATCH special-serial chip (trophy case / special-serial boards); `subedition_id` / `subedition_name` carry the TopShot parallel printing (e.g. Hexwave/Jukebox) on `setID:playID::subID` editions.

The denormalised `player_name` / `set_name` / `tier` / `team_name` / `circulation_count` columns DO exist on this table — safe to select directly.

Pinnacle editions live in parallel table `pinnacle_editions` with different schema: id (text), external_id (text), edition_key (text), character_name, franchise, set_name, variant_type, edition_type, mint_count, is_chaser, thumbnail_url, ask_price, ask_source, plus 10+ Pinnacle-native columns (studio, materials, effects, size, color, thickness). `edition_key` format: `royalty_code || ':' || variant_type || ':' || printing`.

### Disney Pinnacle has THREE transaction types, not two (2026-08-22)

⚠ **A Pinnacle Pin changes hands three ways, and until 2026-08-22 only two were tracked.** Reading Pinnacle "market activity" off `pinnacle_sales` alone under-counts the market by roughly HALF.

| type | table | on-chain signature | writer |
|---|---|---|---|
| storefront **SALE** (priced) | `pinnacle_sales` | `NFTStorefrontV2.ListingCompleted` | `/api/pinnacle-sales-indexer` |
| primary **MINT** (pack/airdrop/primary-buy — indistinguishable on chain, so labelled `mint`, never `pack_pull`) | `pinnacle_mint_events` | `Pinnacle.PinNFTMinted` + same-tx `Deposit` | `supabase/functions/ingest-pinnacle-mints` |
| peer-to-peer **TRADE** (no price) | `pinnacle_trade_events` | ≥1 `Pinnacle.Withdraw` + ≥1 `Deposit`, **exactly two wallets, each on BOTH sides**, one atomic tx | `/api/cron/pinnacle-trades-indexer` |

⚠ **The trade rule is geometric and needs no storefront or mint lookup** — a mint emits a Deposit with **no** Withdraw, and a sale's seller appears only as `from` while its buyer appears only as `to`. Measured over two independent 10,000-block windows (2026-08-22) and validated in both directions against `/v1/transaction_results`: geometry=TRADE → 14 tx / 77 Pins, storefront events in **0**; geometry=NOT-trade → 26 tx, storefront events in **26 of 26**. **In the same windows 77 Pins moved by trade against 79 by sale.**

⚠ **"Two wallets and several Pins" is NOT the rule.** A bulk one-way transfer of 25 Pins is two wallets and many Pins and is not a trade. The test is that **both** wallets appear on **both** sides. Rule + fixtures: `lib/pinnacle/trade-classifier.ts`.

⚠ **`pinnacle_trade_events.pins_in_trade` is trade SIZE, not trade count** — a 25-Pin swap is 25 rows and ONE trade. `count(*)` gives Pins moved; group by `transaction_id` (or read `pins_in_trade`) for trades.

⚠ **A trade has NO price and no path here invents one.** `backfill_pinnacle_trade_acquisitions` (pg_cron `23 */3`) omits `buy_price` from its INSERT column list entirely — the same asymmetry the mint path uses, because a 0 renders a 100%-profit moment forever. `acquisition_method = 'trade'` labels as **"Traded"**, never "Bought": `resolveMomentPnlBasis()` trusts only `Bought`/`Loan` as a cost basis.

⚠ **`pinnacle_ownership_snapshots` is NOT a transaction log and cannot count trades** — it is a latest-owner MAP, upserted one row per `nft_id`, with no counterparty and no tx, and its `observed_at` is write time (the backfill scan writes it too), not market time. A 7-day `observed_at` window returned rows spanning ~16.7M blocks.

⚠ **History before block 162,153,000 is NOT backfilled.** The forward cursor was seeded at that floor; a downward backfill is a separate unbuilt workstream, so a trade-volume series has a hard left edge there.

### wallet_moments_cache (wmc)

UNIQUE constraint: `(wallet_address, collection_id, moment_id)` — the cross-collection-safe shape (replaced the old `(wallet_address, moment_id)` on May 6). Columns include `edition_key`, `serial_number`, `tier`, `set_name`, `player_name`, `character_name`, `mint_count`, all populated by JOIN-to-editions backfill RPCs.

**`fmv_confidence` (added 2026-08-11, `6bd15560`) — wmc is the portfolio store and ~34 DB functions sum `wmc.fmv_usd`, but until then the table carried the VALUE with no LABEL**, so `fmv_current.confidence` was structurally unavailable at the point a portfolio total is computed and `get_wallet_collection_snapshot` (behind the anon-public `/share/[wallet]`) emitted per-collection FMV with no confidence field at all. Typed `public.fmv_confidence`, nullable/no-default (metadata-only on a ~2.3 GB table) and **deliberately unindexed** — `idx_wmc_cohort_cover` already INCLUDEs `fmv_usd` and the table's HOT ratio is 1.8%, so an index would cost writes for no read benefit. `populate_wmc_fmv_from_snapshots` writes it in both paths **from the same snapshot row as the value**; its force-path change-detection was widened to fire on a differing LABEL too, else already-correct rows keep a NULL label forever. Bounded backfill: `backfill_wmc_fmv_confidence(uuid, int)`.

⚠ **DURABLE — the FMV propagation path had NO DB-visible failure signal, so no monitor could ever have alerted on it (`cd1018f0`, 2026-08-12).** `refresh_wmc_fmv_changed` + `refresh_wmc_fmv_drift_active` were failing `57014` on EVERY 5-minute tick for 10+ hours while `pipeline_runs` showed **988 runs and ZERO failures**: the per-collection rows come from `runOne` (which succeeds), the route returns **202 by design**, and the RPCs' only failure signal was `console.log`. The drift ran long enough to reach Top Shot **7% exact-match** and AllDay **p95 14.2×** against `fmv_current`. Both RPCs now log their own `pipeline_runs` rows. **A route that returns 202 and a wrapper that succeeds do not make the work inside observable — give each failing unit its own row.**

### Account linking (May 8)

- `linked_accounts(parent_addr text, child_addr text)` — PK on the pair. 113 links as of 2026-07-16 (was 6 at the May 8 note).
- RPCs: `get_linked_parents(child_addr)`, `get_linked_children(parent_addr)`, `get_linked_all(addr)`, `resolve_canonical_owner(addr)`.
- View: `analytics_sales_resolved` — re-projects `analytics_sales` through canonical-owner resolution to deduplicate parent + child wallets in leaderboards.
- Ingest pipeline: `hybrid_custody_events` cron every 20min via cron-job.org.

### fmv_snapshots table

Wide table — full column set (verified live 2026-07-16): id, edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd, confidence, top_shot_ask, flowty_ask, cross_market_ask, sales_count_7d, sales_count_30d, unique_buyers_30d, offer_count, listing_count, days_since_sale, velocity_factor, utility_factor, loan_factor, algo_version, computed_at, collection, liquidity_rating, asp_without_outliers, ask_proxy_fmv. Key ones: `edition_id`, `fmv_usd`, `confidence`, `computed_at`. **NO `source` column** (still true — do not filter on one).
`confidence` is enum `fmv_confidence` UPPERCASE: `HIGH`, `MEDIUM`, `LOW`, `NO_DATA`, `ASK_ONLY`, `SALES_ONLY`, `STALE`. Never use `.eq("confidence", "high")` — always uppercase, and never use `.ilike` on enum columns (use `.eq` per `f55e022 + e9c90e5` fix).

**Two confidence vocabularies (footgun):** `fmv_snapshots.confidence` accepts `HIGH | MEDIUM | LOW`, but `nba_player_projections.confidence` is gated by a different CHECK that allows only `HIGH | MED | LOW` (3-letter MED).

`fmv_snapshots` is partitioned. `CREATE INDEX CONCURRENTLY` runs ONLY from a one-statement pg_cron job (libpq) — `execute_sql` and `apply_migration` both wrap in a transaction; see General rules. FMV write pattern: delete-then-insert NEVER upsert; `collection_id NOT NULL`. Daily duplicates are intentional history, not a bug.

⚠ **DURABLE — `fmv_snapshots` history only begins 2026-03-31, while `sales` goes back to 2020-07-28.** So NO long-horizon view can be built from FMV: the edition chart's `365d` chip had never once shown a year — it silently showed the ~4.5 months that exist. Any window longer than that must read **actual sale prints** instead (`get_edition_sale_history` → `/api/entity/edition?part=sale-history`, added 2026-08-11 in `9d6e2408`; median/low/high/count per bucket, grain adapts day→week→month and is RETURNED on every row so the axis label is measured rather than assumed). ⚠ **The two series must NOT be merged — an FMV estimate and a median print are different quantities**; the chart switches source per window rather than stitching them. Also note the sale-history clamp floors at **0** (`days<=0` = all time) and deliberately does NOT reuse the fmv-history floor of 7, which would turn ALL into a week.

⚠ **`fmv_snapshots_2025` and `_2027` hold ZERO rows and 0 bytes, and probing them is not free** (measured 2026-08-14). A per-row correlated lookup walks an `Append` over EVERY partition, and an empty partition's index root still costs **2 buffers per probe** — on `get_pack_detail_bundle`'s 1,531-edition hero leg that was **3,062 buffers, ~33% of the leg, for nothing**. Adding **`and fs.computed_at <= now()`** hands the planner the partition key and it prunes at RUNTIME (`Subplans Removed: 1`), taking that leg 9,131 → 6,308 buffers on the SAME index. It is semantically a no-op (a snapshot cannot be computed in the future; 0 future-dated rows), and when 2027 begins it simply stops pruning — **it degrades, it never breaks**. Reach for this on any per-row `fmv_snapshots` lookup.

⚠ **DO NOT "fix" a slow `fmv_snapshots` lookup by adding `collection_id` to reach the covering index — that was measured and REJECTED.** It does exactly what it promises (`Index Only Scan` on `fmv_snapshots_2026_coll_ed_ct_fmv_idx`, planner cost 2906 → 1948) and is still worse: that index is **113 MB with 15,621 lifetime scans** against the **61 MB / 38.9M-scan** `edition_id_computed_at` index the lookup uses today, so on a **2 GB** instance it evicts the hottest index on the platform — measured cold it read **1,630 pages against 137**, and cold is precisely the case that times out. ⚠ **And "Index Only Scan" is a misnomer on this table: `Heap Fetches: 1,292` of 1,531**, because the delete-then-insert FMV write pattern keeps pages non-all-visible. **That is exactly why the estimate and the measurement disagree — the planner's cost model assumes the visibility map pays off, and on `fmv_snapshots` it does not.** A cost estimate is not a measurement.

Most recent FMV per edition:
```sql
SELECT DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC
```
⚠ **Prefer the `fmv_current` VIEW over a hand-rolled version of that query, and NEVER dedup raw `fmv_snapshots` in JS.** At a measured **40.7 snapshots per edition**, PostgREST's 1000-row cap covers only ~25 editions of a DESC read, so a "latest per edition" assembled client-side silently answers for a fraction of the batch — and, because the missing rows look like absence, publishes **"No FMV data yet" for editions we have priced**. That is deep-audit **D27**, and it was still live on **`/api/fmv` — the DOCUMENTED PRODUCT API** — until 2026-08-15 (`8f59749b`), covering **50 of a 100-edition batch**, while two sibling routes had already fixed it and left comments citing D27. Fixed by reading `fmv_current` with 500-chunked `.in()`. ⚠ **Copying the sibling fix verbatim 400s the route: `fmv_current` exposes `wap_usd` DIRECTLY and has NO `asp_usd`**, so the `wap_usd:asp_usd` alias the snapshots query used does not carry over — verify against `information_schema` rather than the sibling. *Reading the sibling is not reading the file.*

⚠ **THE `fmv-recalc` SWEEP IS DEGRADED AND HAS BEEN ALL MONTH — do not read a green-looking FMV surface as proof it is healthy (measured live 2026-08-15).** The trust arm **`fmv_sweep_wedge_hours` is BREACHED and ACCELERATING — 4.30 → 4.68 → 7.40 h over ~8 h on 2026-08-15, against a breach_at of 3** — and the daily rollup shows why:

| day | runs | fail | fail % | rows written |
|---|---|---|---|---|
| 08-07 | 125 | 1 | 0.8% | 59,803 |
| 08-11 | 92 | 10 | 10.9% | 44,674 |
| 08-13 | 93 | 7 | 7.5% | 45,054 |
| **08-14** | **41** | **21** | **51.2%** | **10,684** |
| 08-15 (part) | 48 | 13 | 27.1% | 19,216 |

⚠ **Read the current day as PARTIAL — `pipeline_runs_daily` accumulates, so quoting today's row beside finished days understates it and reads as recovery.** The 08-15 row was 40/6/18,720 at 12:30 PT and 48/13/19,216 at 15:20 PT: **8 more runs produced 7 more failures and only 496 more rows.** Against 08-13's finished 93 runs / 45,054 rows the shortfall is the story, not the fail percentage.

⚠ **THE "RUNS HALVED" HALF IS SOLVED, AND THIS FILE'S FIRST READING OF IT WAS WRONG (measured 2026-08-15).** It said the halved run count was "NOT explained by the failure rate — fewer runs were *started*, so look at the scheduler". **`pipeline_runs` counts SURVIVORS, not invocations**: `fmv-recalc` writes its terminal row at the END, so a run killed at the 300 s cap writes *nothing* — it is not a failure, it vanishes. The route's own **`fmv-recalc-heartbeat`** marker (added 2026-06-11) plus the NOT-EXISTS correlation documented in its comment settles it:

| day | terminal rows | **killed at maxDuration** | total invocations | **% killed** |
|---|---|---|---|---|
| 08-12 | 87 | 54 | 141 | 38.3% |
| 08-13 | 93 | 69 | 162 | 42.6% |
| **08-14** | **41** | **124** | **165** | **75.2%** |
| 08-15 | 40 | 69 | 109 | 63.3% |

⚠ **RE-MEASURED 2026-08-16 19:10Z — IMPROVING, STILL LOSING MORE THAN HALF, AND THIS IS NOW A WATCHED ARM:** 08-14 **65.3%** (176 invocations) · 08-15 **54.1%** (209) · 08-16-to-date **53.4%** (161). The direction is real but the level is not survivable: **over half of every invocation is still killed.** ⚠ Two caveats on the numbers. My correlation window was ±10 min against the heartbeat, so these differ from the 75.2% row above (a different pairing) — **use one method or the other, do not mix rows across the table**; and **08-13 is retention-truncated** (heartbeat rows prune at ~73 h), so its apparent 80.6% is a partial sample and must not be read as a peak. ⚠ **The "nothing watches this" line below is now OUT OF DATE: `fmv_sweep_stall_pct_24h` exists on the trust board and BREACHED on 08-16 at exactly 50 against `breach_at` 50** — it is measuring precisely this stall rate, so the ~50% plateau and the new breach are one fact, not two. Treat it and `fmv_sweep_wedge_hours` (12.17, risen at eight consecutive readings) as a single signal for this subsystem.

**Total invocations are FLAT — the scheduler never changed; the COMPLETION rate collapsed.** So there is ONE regression (saturation), not two. ⚠ **Killed runs still do real work but record none of it**, so `rows_written` undercounts actual repricing by roughly the kill rate — do not read 10,684 as total throughput. ⚠ **Nothing watches this**: the kill-detection query exists only as a COMMENT, and cadence-based monitors cannot see it because the cron fires perfectly — it is the work inside that dies. ⚠ **Do not "fix" it by raising `maxDuration`** (800 s is a hard cap whose breach ERRORs the deploy invisibly, and a longer run holds a pooled connection longer on the very instance that is saturating); the lever is page size per invocation. Filed: [inbox 2026-08-15T1600Z](../../docs/overnight/inbox/2026-08-15T1600Z-fmv-recalc-is-not-running-less-it-is-being-killed.md). The **chronic ~8–13%/day failure rate** since ≥08-08 is the separate, still-open half. Within the ~73 h `pipeline_runs` window: 156 ok / 41 failed, by `extra->>'stage'` — `step1b_refetch_empty` **30**, `step3_today_purge` **7**, `step1a_edition_page` **4**. Every recorded `last_error` is **saturation-class** (`sales_refetch_failed: … (saturation-class)`, `step3_delete_chunk_failed: canceling statement due to lock timeout`, `edition_page_fetch: Timed out acquiring connection from connection pool`), which converges with the entity-page and insights-cache findings on one root cause: **concurrent connections against a 2 GB instance**, not individual query plans. ⚠ **Reading this arm has a trap: `fmv-recalc`'s `extra` carries NO `cursor_before` / `cursor_after` keys on ANY row** (successful runs carry `has_more` / `page_size` / `edition_limit`; failed runs carry only `algo_version` + `stage`), so a cursor-advance query against `extra` returns NULLs that mean *the key is absent*, not *the cursor did not move*. ⚠ **But cursor progress IS measurable and an earlier version of this line implied otherwise — `cursor_before` / `cursor_after` are real COLUMNS on `pipeline_runs`**, populated on 201/201 and 194/201 `fmv-recalc` rows with 157 showing an advance. **Read the columns, not `extra`.** ⚠ **AND THEY ARE `text`, SO `max(cursor_after)` IS A LEXICOGRAPHIC MAX AND SILENTLY REPORTS THE WRONG CURSOR (measured 2026-08-17).** `max()` over the last 7 h of `fmv-recalc` returns **`'9500'`**, because `'9500' > '11500'` as a string; `max(cursor_after::numeric)` returns **11500**. The failure mode is the dangerous direction: it makes a **wedged** sweep look like an advancing one — it reported a cursor of 9500 against a pipeline pinned at 2500 for four hours, and combined with an `ok`-count over a window that straddles the previous cycle's successes it produced a confident "the wedge cleared" reading that was flatly wrong. **Cast to numeric, or read the rows in `started_at` order rather than aggregating.** Same family as the `?? 0`/`|| 1` class: a plausible number manufactured by an operation that was never valid on that type. For throughput use `rows_written` in `pipeline_runs_daily`, which is also the only place the pre-08-12 history survives the 73 h prune — bearing in mind it counts survivors only.

⚠ **DURABLE, AND IT ALREADY COST A WRONG DIAGNOSIS — a `phase: "started"` marker row publishes a `duration_ms` that is NOT the run's duration.** `pipeline_runs.duration_ms` is **`GENERATED ALWAYS AS (finished_at - started_at)`** and **`finished_at` is `NOT NULL DEFAULT now()`**, so any marker that omits `finished_at` silently publishes **the latency of its own INSERT**. Deep-audit run 2 read drain-conflated-subeditions' 147/176/185 ms as the route "dying instantly"; it is in fact running to its 300 s ceiling and being killed — **the opposite conclusion, pointing at a different fix**. Both marker writers now pin `finished_at = started_at` so `duration_ms` is a hard **0**, an obvious sentinel (fixed 2026-08-15; 514 `fmv-recalc-heartbeat` rows had been publishing 42 ms–56 s of pure insert cost). Guarded by `__tests__/pipeline-start-marker-duration-is-not-a-measurement.test.ts`, which **scans for the marker pattern rather than naming files**, so a new marker writer is covered the day it lands. **On any unfinished row, read `extra`/`ok`, never `duration_ms`.**

### sales table

Year-partitioned: `sales_2020` through `sales_2027` (8 partitions, verified live 2026-07-16 — `sales_2027` is pre-created for next year). Dedup on `transaction_hash` (unique index in sales_2026).

⚠ **DURABLE — there is NO index on `sales.ingested_at`** (verified live 2026-08-08; every sales index is keyed on `sold_at` / `collection_id` / `edition_id`). So ANY predicate on `ingested_at` — even a small window — **seq-scans the multi-million-row partitions** and times out under pooler saturation (a 24h/7d group-by on it blew the 60s MCP budget). Query recent sales by **`sold_at`** and **filter by `collection_id`** so it rides `sales_2026_collection_id_sold_at_idx (collection_id, sold_at DESC)`; a bare `sold_at > now()-interval` with no collection filter also seq-scans (no leading-`sold_at` full index — the `sold_at DESC` ones are all partial `WHERE price_usd…`). ⚠ **The sentinel's `Sales Ingest (2h)` check is NOT superseded by the per-collection arm below, and must not be deleted as redundant** (this line used to say "left as-is, superseded by the per-collection arm" — corrected 2026-08-13 after nearly acting on it). The two answer different questions: `sentinel_sales_ingest_health()` keys entirely on **`sold_at`** (market time), while this keys on **`ingested_at`** (did we WRITE anything), so a history backfill landing rows dated months ago is invisible to one and plainly visible to the other — the same asymmetry that makes the `sold_at` keying load-bearing for `ufc_flow_revival_sales_30d`. It is also the only sales-ingest tripwire that reads the sales TABLE rather than `pipeline_runs`, and that independence is the point: a 403'd edge fn writes no `pipeline_runs` row at all. **Its cost WAS the problem and is now mostly fixed** (`app/api/sentinel/route.ts`, 2026-08-13): measured at ~2.2 GB/call, 11.7% buffer hit, 28.3 GB over 39.7 h — the largest low-hit-ratio reader on the instance — it now bounds **`sold_at` (the partition key)** so the planner prunes 6 of 8 partitions (`EXPLAIN` cost **212,454 → 107,025**), which also makes it STRICTER: a lone history backfill used to satisfy it while every forward indexer was dead. The unbounded scan still runs, but **only when the bounded one reads zero**, where it earns its cost by separating "forward ingest is dead" from "everything is dead" — a distinction the old check could not make. The year floor carries a 45-day offset so there is no New Year cliff. Do not "finish" this by dropping the check or the second probe. **Per-collection + per-source sales-ingest health** (2026-08-08): `sentinel_sales_ingest_health()` (SECDEF, service-role-only, index-bounded per collection) + config table `sentinel_ingest_watch` (per-collection silence-ceiling + loudness: **page** TS/AllDay, **warn** Candy/Golazos/Pinnacle, **off** UFC — its revival is caught by `v_rpc_trust_health.ufc_flow_revival_sales_30d`). Ceilings are calibrated from each collection's worst normal 14d inter-sale gap; Pinnacle is folded in from its separate `pinnacle_sales` table. Surfaced as the sentinel's `Sales Ingest by Collection` + `Sales Ingest by Source` checks so a single collection/lane silently ceasing to land rows (indexer green, aggregate masked by TS's ~92%) finally pages instead of hiding.

### badge_editions table

Has (verified live 2026-07-16): player_name, series_number, tier, parallel_id, parallel_name, play_tags, set_play_tags, low_ask, highest_offer, avg_sale_price, circulation_count, badge_score, collection_id, external_id, set_id, play_id, … There is **NO `badge_type` column** (the earlier note was wrong) — badge tag slugs live in `play_tags` / `set_play_tags`. Use `.or()` with ilike for case-insensitive player name matching. Always `.trim()` player names.

### flowty_transactions table

- `flowty_transactions.failure_category` is unconstrained TEXT and now **historical/frozen** — it was populated by `lib/flowty-tx-classifier.ts`, which was removed in the Flowty-teardown Phase 2 (`36aabf28`, 2026-05-23). The old `FailureCategory` union + first-match-wins `RULES` ordering (specific before broad, e.g. INSUFFICIENT_GAS_FUNDS before INSUFFICIENT_BALANCE) survives only in git history + `docs/flowty-classifier-coverage-findings.md`. (`flowty_loan_events` has been cold since 2026-05-11; this whole subsystem is dead history — distinct from the LIVE Flowty *listing-cache* ingest, see Known issues #1.)
- Flow Error Code 1118 is a payer-gas error (pre-execution), distinct from in-execution Cadence errors. Categorized as `INSUFFICIENT_GAS_FUNDS`.
- ⚠ **`flowty_transactions` RECENCY IS A LYING INSTRUMENT — the whole feed stopped ~2026-05-24 for EVERY collection, so a per-collection `max()` reads as that collection's last trade.** Measured 2026-08-18 while testing whether UFC Strike is dormant: `max(created_at)` for `ufc` = **2026-05-23**, which is TEN DAYS LATER than UFC's last row in `sales` (2026-05-13) and therefore reads exactly like *the sales indexer is missing trades*. **It is not.** The control: `max(created_at)` for `topshot` = **2026-05-24**, while `sales` for `nba_top_shot` was current to the minute. **The table died a day after that UFC row, across the board.** ⚠ Never read a last-activity date out of this table without the same-table control from a collection you KNOW is live — the failure inverts the conclusion rather than merely weakening it. (Short-form vocabulary here: `topshot`/`allday`/`golazos`/`pinnacle`/`ufc`.)
- ⚠ **`cached_listings_v2` is NOT an order-book instrument for every collection** — it holds rows for `disney_pinnacle`, `laliga_golazos` and `nfl_all_day` only. **Top Shot listings live in `topshot_active_listings` / `ts_listings`, and UFC has no listing ingest at all.** So "collection X has no rows here" means *not ingested*, not *no live listings* — measured 2026-08-18, when the UFC-dormancy question nearly took the empty result as evidence.

- ⚠ **AN "INDEX ONLY SCAN" DEGRADES SILENTLY WHEN THE VISIBILITY MAP ROTS, AND ON A CHURN-HEAVY TABLE DEFAULT AUTOVACUUM CANNOT KEEP UP.** Measured 2026-08-18 on `wallet_moments_cache` (2.28M rows, 16.5M lifetime updates, 10.1% dead): the covering `idx_wmc_cohort_cover` was doing **1,056 Heap Fetches on a 1,498-row wallet — 9.3 s** under concurrent disk-IO saturation, so `reconcile_all_saved_wallet_stats` (pg_cron jobid 259, hourly) hit the 120 s hard `statement_timeout` on a whale wallet and had been **truncating for over a week**: every saved wallet's `cached_moment_count` / `cached_fmv_usd` was frozen at its Aug 9 value on the dashboard, profile and share cards. **The fix was not a query rewrite** — VACUUM (ANALYZE) plus a durable `ALTER TABLE public.wallet_moments_cache SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.02, autovacuum_vacuum_insert_scale_factor=0.05)` took the same wallet to **292 Heap Fetches / 796 ms (~12×)**. ⚠ **The default 20% scale factor is the trap**: on a table with this much update churn the VM is stale long before autovacuum fires. ⚠ A manual pg_cron `VACUUM` died at the role's 120 s timeout but *triggered* the autovacuum that finished the job — so "the VACUUM failed" did not mean the table was untouched. Revert: `ALTER TABLE … RESET (…)`.

### General rules

- ⚠ **AN A/B QUERY BENCHMARK MUST BE WARM-VS-WARM, OR THE CACHE ORDER PICKS THE WINNER.** Measured 2026-08-18 rewriting `get_fmv_coverage()`: the candidate ran FIRST (cold, `read=9,579`) at **8,197 ms** and the incumbent ran SECOND (warm, `read=802`) at **1,470 ms**, which reads as *the rewrite is 5.6× SLOWER* and would have killed a correct change. Re-running the candidate warm inverted it — **909 ms vs 1,470 ms**. ⚠ **BUFFERS are the load-independent number and they were stable across every run (196,106 → 100,014); the milliseconds moved 9× on cache state alone.** Protocol: run each shape at least twice, compare only same-warmth runs, quote buffers as the result and timings as corroboration. This is the DB analogue of the recorded HTTP rule that a byte-identical response is as much a cache hit as a correct change.
- ⭐ **AND WITHIN ONE PLAN, TOTAL BUFFERS RANKS LEGS BY WORK WHILE `read` BUFFERS RANKS THEM BY COST — quote the SPLIT, not the total** (measured 2026-08-29, and it reconciled two sessions that measured the same view and disagreed). `candy_special_serials_board`, cold: the per-serial `sales` LATERAL took **36,410 hit / 142 read → 2,229 ms**, while the `candy_treasury_wallet` InitPlan took **16,429 hit / 5,269 read / 1,415 dirtied → 42,817 ms**. **2.0 ms per buffer against 0.06 — a 33× difference that the cold-read column explains entirely.** ⚠ **Ranking by TOTAL buffers puts the sales leg first; ranking by WALL CLOCK puts the treasury leg first; both were reported, by different sessions, as the answer.** ⛔ Wall clock remains the wrong unit (it moves 9× on cache state — see the bullet above), **but a bare buffer total silently treats a cache hit and a cold random read as the same event, and on this instance they are not.** 👉 **Read `hit` and `read` separately from every `EXPLAIN (ANALYZE, BUFFERS)` leg, and say which one you ranked on.** Case: [inbox 2026-08-29T0432Z](../overnight/inbox/2026-08-29T0432Z-candy_treasury_wallet-costs-21698-buffers-per-render-and-is-the-whole-residual.md).
- ⚠ **A FILING'S PROPOSED FIX CAN BE RIGHT WHILE ITS DIAGNOSIS IS WRONG — ship the fix on its own merits and do NOT let it inherit the diagnosis's credit.** Same case: the filing said `get_fmv_coverage()`'s duplicated `EXISTS` "took the whole data-integrity monitor down (did not finish in 55s)". In a quiet window the OLD body ran in **~1.5 s** — the 55 s was measured *during* a saturation spell. The rewrite was still worth shipping (2× the buffers for one number), but it is **not** the timeout's fix, and recording it as one would have retired a live risk on paper. **Re-measure the INCIDENT claim separately from the WASTE claim; they are different assertions and only one of them was true.**
- ⚠ **Measure in a quiet window and PROVE it was quiet, with a number.** The cheap check, all from `pg_stat_activity`: active sessions, of those `wait_event_type='IO'`, and `backend_type='autovacuum worker'` (plus the autovacuum's target table). 2026-08-18 read **14 active / 9 IO-wait / 2 autovacuums** in the afternoon and **3 / 1 / 0** two hours later — the same query, the same day, and the second is the only one worth timing on.

- `apply_migration` for DDL; `execute_sql` for reads/verification.
- ⚠ **`CREATE INDEX CONCURRENTLY` IS REACHABLE FROM HERE — via a ONE-STATEMENT pg_cron job, not `execute_sql`. The recorded "no channel can run CIC" is OVERTURNED (proven end-to-end 2026-08-18 building `idx_wmc_fmv_conf_null` on `wallet_moments_cache`).** `SHOW cron.use_background_workers` = **`off`**, so pg_cron connects over **libpq** and sends the job command as a simple query; a **single-statement** command is then its own implicit transaction, which is exactly what `CONCURRENTLY` requires. The `25001 cannot run inside a transaction block` that earlier sessions hit is real but is a property of **multi-statement** commands (`SET …; CREATE INDEX CONCURRENTLY …`), which libpq wraps — as are `execute_sql`, `apply_migration`, and any function body. **One statement, no wrapper, no error.** This matters because the fallback — a plain non-concurrent build — takes `ACCESS EXCLUSIVE` on the target table for the build's whole duration, and on `wallet_moments_cache` that blocks every read of the hottest table product-wide.
  - **Recipe.** (1) `ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = '30min';` — the global default is **120000 ms from `/etc/postgresql-custom/platform-defaults.conf`** and `postgres` carries no `rolconfig` override, so a fresh pg_cron libpq login inherits **2 min** and the build dies there. ⚠ It is applied at **LOGIN**, so it must be set BEFORE the job fires, and **reverted immediately after** (`RESET statement_timeout`). (2) `cron.schedule('<name>','<minute> * * * *','<ONE statement>')`. (3) The moment the run appears in `pg_stat_progress_create_index`, `cron.alter_job(<id>, schedule := '55 5 1 1 *')` so it cannot re-fire — **do not `cron.unschedule` a job whose run is in flight**. (4) Verify `indisvalid AND indisready`, then `cron.unschedule` and revert the role setting. Observed: `DROP INDEX CONCURRENTLY` ~90 s (all of it `Lock/virtualxid`, waiting out open transactions — it blocks nobody); `CREATE INDEX CONCURRENTLY` ~2 m 20 s over a 874 MB / 113,729-block heap.
  - ⚠ **A cancelled CIC leaves an INVALID 0-byte stub, and `IF NOT EXISTS` then silently no-ops and reports success against a dead index.** Drop it first and build **without** `IF NOT EXISTS`. ⚠ **A plain `DROP INDEX` of that stub still needs `ACCESS EXCLUSIVE`** — it `55P03`'d under `lock_timeout='3s'` even though the stub is inert (`indisready=false`, 0 bytes). Drop it `CONCURRENTLY` via the same route.
- ⚠ **INDEX DDL CAUSES NO `PGRST002` BURST — the "every migration costs 10–20 s of 500s" rule does NOT apply to it** (read from source 2026-08-18). `pgrst_ddl_watch` notifies only for an explicit command-tag list (`CREATE`/`ALTER SCHEMA`, `TABLE`, `FOREIGN TABLE`, `VIEW`, `MATERIALIZED VIEW`, `FUNCTION`, `TRIGGER`, `TYPE`, `RULE`, `COMMENT`) and `pgrst_drop_watch` for object types `schema/table/foreign table/view/materialized view/function/trigger/type/rule`. **`CREATE INDEX`, `DROP INDEX` and the object type `index` are on NEITHER list.** So index work is free of the schema-cache outage — check the two watch functions before assuming any given DDL pays it.
- ⚠ **A FUNCTION-LEVEL `SET statement_timeout` IS INERT, AND THE POPULATION IS 195 FUNCTIONS — this file has recorded the trap THREE TIMES as an anecdote ("second instance of that trap", "the function-proconfig trap again") and never once measured how many objects carry it (sized 2026-08-16).** A `SET statement_timeout` in `proconfig` **does not bind the statements inside that function**; this repo proved it twice with live probes (300 ms declared, `pg_sleep(5)` ran to completion; and a 500 ms declaration whose second `pg_sleep(3)` ran unbounded after a caught cancel) — those two measurements are the grounding, and **this pass did not re-probe**, it counted. Live:
  | | |
  |---|---|
  | `public` functions declaring a `statement_timeout` | **195** |
  | …declaring **more than** the global 120 s | **47** |
  | …declaring more than the highest ROLE ceiling (600 s) | **1** — `fmv_thin_sale_ask_disclosure_refresh` at **900 s** |

  ⚠ **READ THE NEXT TWO BULLETS BEFORE USING THIS TABLE — these are LOGIN-time settings, and `service_role`'s 30 s provably does NOT bind on the PostgREST path (measured 2026-08-17).** They are correct for pg_cron (which logs in as its job owner) and misleading for `supabaseAdmin`. ✅ **SETTLED FOR `anon` 2026-08-17 — AND THE ANSWER IS THE BAD ONE THIS BULLET PREDICTED: anon's 3 s DOES NOT BIND.** Measured directly, modelling the real request path (`SET LOCAL statement_timeout = '8s'` — what `authenticator`'s LOGIN supplies — then `SET LOCAL ROLE anon`): `current_user` becomes **`anon`** while `statement_timeout` stays at **`8s`**. The declared 3 s never applies, exactly as the `SET ROLE`-does-not-inherit-`rolconfig` mechanism predicts. ⚠ **The pivot nobody had noticed is that `authenticator` carries its OWN `statement_timeout=8s`** — and *that* one binds, because `rolconfig` applies at LOGIN and PostgREST logs in as `authenticator`. Corroborated at scale: authenticator-attributed statements in `pg_stat_statements` show **max 7,474 ms with 3 over 3 s and ZERO over 8 s** — a distribution clipped by an 8 s ceiling. ⚠ **So `authenticated`'s declared 8 s is correct BY COINCIDENCE, not because its rolconfig binds** — it simply equals authenticator's. ⚠ **Do NOT conclude the universal effective ceiling is 8 s**, because `service_role`-attributed statements demonstrably reach **352 s** on the same pool; whatever raises it for that path is NOT established from here (it needs the PostgREST/Supabase per-request config, which is unreadable from this sandbox). **What is proven is the negative, and that is the load-bearing half: there is no 3 s bound on unauthenticated compute.** ⚠ **CONSEQUENCE — the anon-executable-function findings under Security posture get WORSE, as predicted:** the argument for leaving **78** anon-executable invoker functions in place leaned on unauthenticated work being cut off at 3 s. It is at least **8 s (2.67×)** and possibly far more, so a heavy anon-callable function (the revoked `compute_pack_ev_from_pool_tier_weighted` measured **45.8 s / ~17.4 GB**) would not have been clipped anywhere near as early as assumed. ⚠ The anon-attributed sample is still small (10 statements, max 207 ms, none over 3 s) — that is consistent with the finding and does **not** independently confirm the effective ceiling; **the mechanism is what is measured, not the ceiling.**
  **The binding budget comes from the CALLER'S ROLE, or from the global when no role config applies** — `anon` **3 s** · `authenticated`/`authenticator` **8 s** · `service_role` **30 s** · `cron_heavy` **600 s** · global **120 s** (`pg_settings`, source = configuration file). So one function declaring `300s` gets 30 s from a `supabaseAdmin` call, 600 s from a `cron_heavy` pg_cron job, and 120 s otherwise — **and never the 300 s it declares.** ⚠ **The 47 that declare ABOVE the global are the actively misleading ones**: each reads, to anyone opening the function, as a granted budget that no caller can ever supply, so a session diagnosing a timeout there computes against a ceiling that does not exist. **This is not a tidy-up item — it is why three separate investigations (`8918307c`'s drain seeders, the eight `rpc_thp_leg_*` legs, and `match_topshot_players_run`) each independently reached for "raise the declared timeout" and each would have changed nothing.** ⚠ **Do NOT mass-strip the declarations**: a `CREATE OR REPLACE FUNCTION` touching 195 objects is a large blast radius for a cosmetic win, and the declaration is harmless where it is *below* the binding budget. **Read the role ceiling, not the function header**, and treat any timeout fix that only edits `proconfig` as a no-op by construction.

  ⚠ **BUT THE RULE HAS A TESTED HALF AND AN UNTESTED HALF, AND THERE IS LIVE COUNTER-EVIDENCE ON THE UNTESTED ONE — do not weaken the rule on it, and do not treat it as settled either (2026-08-16).** Re-probed live, both directions, and the rule **reproduces exactly**: a function declaring `1s` around a `pg_sleep(3)` under a 2 min outer budget **slept fine** (a LOWER declaration is inert), and with the session set to `1s` a function declaring `30s` around a `pg_sleep(3)` **was canceled** (a HIGHER declaration is inert too). ⚠ **Both probes share one limitation, and it is the whole point: the timer was ALREADY ARMED by an outer `SELECT` before the function was entered.** PostgreSQL arms `statement_timeout` at the start of a **top-level statement** and does not re-arm when the GUC changes mid-statement — so those probes only establish the nested case, which is the pg_cron / `CALL` / SQL-inside-SQL path. **The PostgREST path was NOT tested and cannot be tested from an MCP connection** (which runs as `postgres` on the 2 min global budget and cannot model `authenticator` → `SET LOCAL ROLE service_role`). ⚠ **The counter-evidence: `wallet_usernames_unresolved` declares `statement_timeout=60s`, is called by a bare `supabaseAdmin.rpc()` (so `service_role`'s 30 s should bind), and its `pg_stat_statements` `max_exec_time` is 58,206 ms** with failures landing at 60.1–62.2 s. Retry, `maxDuration`, and every role ceiling are ruled out (none is 60). **If the declaration DOES bind through PostgREST, this rule is right for the cron path and wrong for the route path — which is most of the product.** The decisive experiment (two throwaway SECDEF `pg_sleep(45)` functions, one declaring 60 s and one bare, called **through HTTP with the service-role key**) is filed at [inbox 2026-08-17T0440Z](../../docs/overnight/inbox/2026-08-17T0440Z-wallet-username-resolver-dies-in-its-candidate-selection-and-the-proconfig-rule-has-an-untested-half.md).

  ✅ **RESOLVED 2026-08-17 — THE RULE HOLDS FOR ROUTES TOO, AND THE "cannot be tested from MCP" PREMISE WAS WRONG.** No HTTP was needed: a PostgREST RPC is just `SELECT fn(...)` as a **top-level statement**, and there is no way to call a function *except* from a top-level statement — so the "timer already armed by an outer `SELECT`" caveat does not describe a distinct case, it describes every case. Probed in `pg_temp` (⚠ deliberately: `extensions.pgrst_ddl_watch()` and `pgrst_drop_watch()` both skip `pg_temp` explicitly, so a temp probe causes **no schema-cache reload and no user-facing 500s burst** — a `public` probe would have). Both directions, on a **SECURITY DEFINER** function, executing **as `service_role`**:
  | probe | session budget | function declares | sleep | result |
  |---|---|---|---|---|
  | higher declaration (the `wallet_usernames_unresolved` shape) | 2 s | 60 s | 5 s | **canceled at 2 s** |
  | lower declaration | 120 s | 2 s | 5 s | **ran to completion** |

  **Inert in both directions.** So `proconfig` never binds anywhere, and the "keep reading the role ceiling" half of this bullet is right for cron — but ⚠ **the role ceiling itself turned out to be the real error; see the next bullet.**

  ⚠ **THIS RULE WAS RE-DERIVED WRONGLY ON 2026-08-17 AND CAME ONE INFERENCE FROM BEING OVERTURNED — recognise the bad argument by shape, because it is reproducible.** A filed correction claimed `proconfig` **BINDS** on the PostgREST path and overrides `service_role`'s 30 s, "at least 15 functions depend on it", on the evidence that `pg_stat_statements` maxima **cluster just under** declared values (600→352,318 · 300→297,653 · 120→118,038 · 60→58,206). ⚠ **That is SELECTION BIAS — it never queried for EXCEEDANCES.** Filtered to statements matching exactly ONE declaring function and read WITH their query text, the direct single-function invocations blow straight through: `SELECT public.refresh_mv_pack_ev_latest()` declares **120 s**, maxes at **586,784 ms** over 258 calls; `refresh_atlas_pack_ev` 120 s → 583,629; `backfill_nft_edition_map_from_sales` 120 s → 570,910; `dedup_allday_cross_source_sales` 120 s → 536,759; `promote_unmapped_sales` 300 s → 500,478 over 235 calls; `refresh_allday_badge_low_ask` 60 s → 274,393 over 276 calls. **If `proconfig` bound, every one is impossible.** The clustering is real and means only that whoever wrote those declarations picked a number matching a genuine CLIENT bound — so declared and actual agree *by construction* in that subset.
  ✅ **The same table run correctly gives the POSITIVE result, which is the half worth keeping:** those declarations span **60/90/120/180/240/300 s**, the observed maxima span **99,180 → 586,784 ms**, and **every one lands under 600,000 ms** — `cron_heavy`'s role-level ceiling. **The declaration predicts nothing; the CALLER'S ROLE predicts the cap.**
  ⚠ **TWO JOIN TRAPS PRODUCED A WRONG FIRST REFUTATION OF IT, so use this query shape.** (1) Joining `pg_stat_statements` on *"the function name appears anywhere in `query`"* bills ONE row to several functions: `detect_stalled_pipelines` (declares 8 s) was published at 102,513 ms as a "12.8×" exceedance, and that identical figure also sat under `get_pipeline_alerts` — ⚠ **the same `max_exec_time` to the millisecond under two names is the signature of a bad join, never a coincidence.** The row was a health composite merely MENTIONING both, and `get_pipeline_alerts` does not call `detect_stalled_pipelines` at all. (2) ⚠ **`pg_stat_statements.track = top`**, so a nested call never gets its own row and a name-in-text join silently bills a CALLER's cost to a CALLEE. **Match exactly one declaring function, read the `query` text to confirm the function IS the whole statement, and discard `calls = 1` rows** — those are ad-hoc diagnostics, and one offender was literally an `explain (analyze)`.
  ⚠ **The live falsifier, still unexplained and deliberately not explained away:** `wallet_usernames_unresolved` maxes at **58,206 ms** against a declared 60 s under a route declaring `maxDuration = 120`. Nothing at 60 s accounts for it; it is called a coincidence in the next bullet and no better account exists. **One unexplained point does not outweigh a direct control plus a corrected exceedance table** — but it is where to start if anyone reopens this.

⚠ **`service_role`'s 30 s DOES NOT BIND ON THE POSTGREST PATH, AND THIS FILE TREATS IT AS A HARD CEILING IN SEVERAL DIAGNOSES (measured 2026-08-17).** `rolconfig` (`ALTER ROLE … SET`) applies **at LOGIN**, and PostgREST logs in as **`authenticator`** and then issues `SET LOCAL ROLE service_role` per request — and a `SET ROLE` does **not** pick up the target role's `rolconfig`. Measured directly: `SET ROLE service_role;` then `current_setting('statement_timeout')` still reads **`2min`**, with `current_user` = `service_role`. Corroborated at scale from `pg_stat_statements` joined to `pg_roles` (it is keyed per user, so it names the caller): across **871** distinct `service_role` PostgREST statements — recognisable by the `WITH pgrst_source` wrapper — **244 exceed 8 s, 39 exceed 30 s, 28 exceed 60 s, 10 exceed the 120 s global, and the worst is 352,318 ms (5.9 minutes)**, several with a **mean** over 100 s. ⚠ **So no Postgres-side timeout bounds a `supabaseAdmin` RPC; the effective bound is the CLIENT** — the cluster at **297–300 s** is Vercel's `maxDuration`, not a database ceiling. **Consequences worth acting on:** (1) the `wallet_usernames_unresolved` "counter-evidence" needs no exotic explanation at all — nothing was stopping it at 30 s, and **its 58.2 s runtime matching its declared 60 s is a COINCIDENCE** that came within one inference of overturning a correct rule; (2) ⚠ **the entity-page bullet's supporting argument is UNSOUND** — *"a request that dies at 45 s without Postgres having killed it at 30 s was not executing a statement"* rests on a 30 s kill that does not happen, so that reasoning must not be reused (its conclusion may still hold on other grounds; **re-derive it**). ⚠ **What the ~60 s client-side bound on that route IS remains UNIDENTIFIED and is deliberately not guessed here** — it is not `maxDuration` (that route declares **120**), not `rpcWithRetry`'s 45 s, and not any role ceiling; the leading candidate is the Supabase API gateway's own request timeout, **unverified from this sandbox** (no egress to `*.supabase.co`, no service-role key).
  ⚠ **THE EXPOSURE THIS OPENS IS THE SATURATION STORY, SO SIZE IT BEFORE DISMISSING IT AS ACADEMIC.** Over the **5.58 days** since `pg_stat_statements` was reset (read `pg_stat_statements_info.stats_reset` — without it the totals below are uninterpretable), `service_role` PostgREST statements consumed **389.5 connection-hours** (~70 h/day, i.e. ~2.9 connections continuously busy against `max_connections=90`). **16 distinct statements have a MEAN over 30 s and 6 have a mean over 60 s**; those 16 alone account for **37.4 connection-hours across 2,297 calls** — every one of them running with **no server-side statement bound at all** on a 2 GB disk-IO-throttled instance. ⚠ **So the platform's heaviest caller class has no backstop**, and the only thing that ends a runaway `supabaseAdmin` RPC is the lambda dying at `maxDuration` — after which, note, the statement can keep running server-side. **This is a lever on the documented saturation that is not "fix the query": a real `statement_timeout` for `service_role` would have to be set by the CLIENT or by PostgREST config, because the role-level setting provably does not reach it.**

⚠ **THE SELECTION QUERY IS THE EXPENSIVE PART — a third instance, and it is now a recognised shape (2026-08-16).** `wallet-username-resolver` fails **75.6% of runs** (68/90 over 2 days) and **none of them reach its work loop**: the route opens with one bare `.rpc("wallet_usernames_unresolved", { p_limit: 300 })` and returns early on error, so every failed run reports `rows_found: 0 / resolved: 0 / errored: 0` because it never got the list. That one call measures **mean 16,811 ms, max 58,206 ms, 2.23 M blocks read, 65.2% buffer hit** — to gate work that, on the runs that DO succeed, resolves **0–5 addresses out of a 300 batch in 9.6–33.7 s**. Same shape as `topshot-wmc-fossil-drain` (its `targets:` step is what times out) and the retired `topshot-flowty-unmapped-drain` (where proving emptiness scanned the whole open backlog every tick — **an empty result is the most expensive case**). ⚠ **When a pipeline times out with `rows_found: 0`, suspect the CANDIDATE SELECTION before the work**, and check whether a `LIMIT` bounds rows EXAMINED rather than rows RETURNED — the `backfill_wmc_fmv_confidence` repair (2:13 → 3.5 s from one cron argument) is the precedent. ⛔ **Do not raise its declared timeout**: inert at best, and at worst it holds a pooled connection longer on the instance whose saturation is the root cause.
- ⭐⭐ **SETTLED 2026-08-27 — THE DECISIVE EXPERIMENT DESIGNED ON 08-17 HAS NOW BEEN RUN, AND BOTH SIDES OF THIS FILE'S ARGUMENT WERE RIGHT ABOUT THEIR OWN EVIDENCE. `proconfig` IS PATH- AND DIRECTION-DEPENDENT.** The bullet above prescribed it exactly — *"two throwaway SECDEF `pg_sleep(45)` functions, one declaring 60 s and one bare, called **through HTTP with the service-role key**"* — and said it could not be run from the sandbox (no egress, no service-role key). **Trevor's box has both.** Run 2026-08-27 07:0x PT, two `SECURITY INVOKER` probes identical but for the declaration, both sleeping **40 s**, both POSTed to `/rest/v1/rpc/…` with the service-role key:

  | probe | declares | result |
  |---|---|---|
  | bare | *nothing* | **HTTP 500 at 31 s** — `57014 canceling statement due to statement timeout` |
  | declaring | `SET statement_timeout TO '60s'` | **HTTP 200 at 41 s** — completed, `current_setting` reads `1min` |

  ✅ Reproduced on the real object: `wallet_usernames_unresolved(300)` (declares 60 s) returns **500 at 61 s** through the same path. **Both probes dropped afterwards; `check_secdef_anon_execute_violations()` = `[]`.**

  ⭐ **THE RECONCILIATION, and it is the whole value of this entry: the 08-17 refutation's exceedances are ALL on the OTHER path.** That analysis was right to demand exceedances and right that it found them — but every one it named is a **pg_cron** call. Re-derived by joining `pg_stat_statements` to `pg_roles` and splitting on the `pgrst_source` wrapper that marks a PostgREST statement:

  | caller shape | statements | exceeding their declaration | worst exceedance |
  |---|---|---|---|
  | **bare `SELECT public.fn()`** (pg_cron / `postgres`) | 248 | **44** | **596,559 ms** vs a 120 s declaration |
  | **`WITH pgrst_source …`** (PostgREST) | 106 | **2** | 20,704 ms |

  Every one of the top 12 overruns is `caller_role = cron_heavy` (11) or `postgres` (1), `is_postgrest_shape = false`. **So "if `proconfig` bound, every one is impossible" was true of the sample and the sample was one path.**

  ⚠ **AND THE TWO PostgREST EXCEPTIONS ARE NOT NOISE — THEY GIVE THE SECOND HALF OF THE RULE.** `get_pack_detail` declares **8 s** and reaches **20,704 ms** over 14,033 calls; `get_set_detail` declares **8 s** and reaches **13,167 ms** over 8,127 calls (both `service_role`, both matching exactly one declaring function, so the attribution is clean). **Both declare BELOW `service_role`'s 30 s.** Together with the A/B: **on the PostgREST path a HIGHER declaration RAISES the ceiling; a LOWER one is still inert.** A declaration can buy time, never give it back.

  ⛔ **THE ACTIONABLE CONSEQUENCE, and it is the opposite of the one #43 warns about.** **195 `public` functions declare a `statement_timeout` (parsed to seconds — ⚠ `max()` on the raw text is LEXICOGRAPHIC and reports `'90s' > '600s'`), range 3 s–900 s, and 122 of them declare MORE than `service_role`'s 30 s** — led by `fmv_thin_sale_ask_disclosure_refresh` at **900 s** and four board refreshes at **600 s**. #43 rightly says do not *make the declarations real* as a batch. **The live hazard is the mirror image: a cleanup that strips them as proven no-ops would cap 122 functions at 30 s**, including every board refresh that legitimately runs for minutes.

  ✅ **This also closes the question this file left open twice.** (1) *"What the ~60 s client-side bound on that route IS remains UNIDENTIFIED"* — **there is no client bound; it is the callee's own 60 s declaration.** (2) *"its 58.2 s runtime matching its declared 60 s is a COINCIDENCE"* — **it is not a coincidence; it is the mechanism.** ⚠ And CLAUDE.md's *"no Postgres timeout bounds a `supabaseAdmin` RPC — the bound is the client (worst observed 352 s)"* is **refuted as stated and explained**: the bound is the callee's declaration, and 352 s is what you get when the callee declares 600 s.

  ⛔ **THE MECHANISM IS DELIBERATELY NOT CLAIMED.** A session-level `SET statement_timeout = '3s'` followed by a call to a function declaring `60s` around a `pg_sleep(6)` **still dies at 3 s** — i.e. the 08-16 nested-case probes reproduce exactly. So a higher declaration extends through PostgREST and does *not* extend behind a session `SET`, and **what selects between them is not established here.** Four data points, no unifying story: writing one would be the "a plausible mechanism is not a measurement" error this file exists to prevent. ⚠ **`anon`/`authenticated` were NOT re-probed** — testing them needs an anon-executable sleep function, which is a DoS primitive on a public API and would trip the SECDEF-anon-exec sentinel. The `authenticator` 8 s finding above stands untouched. Filing: [inbox 2026-08-27T1404Z](../overnight/inbox/2026-08-27T1404Z-a-function-statement-timeout-is-INERT-on-pg-cron-and-BINDS-via-postgrest.md).

  ⭐⭐ **ADDENDUM ~07:55 PT — THERE IS A THIRD CEILING ABOVE BOTH OF THESE, AND IT CORRECTS THE PARAGRAPH ABOVE.** *"A `supabaseAdmin` RPC is bounded by its callee's declaration"* is true **only up to ~120 s**. One function declaring `SET statement_timeout TO '600s'`, called through `/rest/v1/rpc/…` with the service-role key, at two sleep lengths:

  | sleep | result |
  |---|---|
  | **110 s** | **HTTP 200 after 111 s** — `COMPLETED 110s; timeout=10min` |
  | **150 s** | **HTTP 504 after 125 s** — body `upstream request timeout` |

  ⭐ **The 110 s run is the positive control and it is what makes the 150 s run readable**: it proves the 600 s declaration really was in force (`service_role`'s 30 s would have killed it at 30) and that nothing else was broken. The 150 s run then dies at **125 s with a 504** — an HTTP status, not a Postgres SQLSTATE. **The Supabase gateway hard-caps a PostgREST request at ~120 s regardless of role or declaration.**

  ⛔ **The two ceilings compose and the lower wins, so a declaration above ~120 s is unreachable on BOTH paths** — inert where pg_cron calls it, gateway-killed where PostgREST does. **48 of 196 declaring functions sit in that band** (up to 900 s: `fmv_thin_sale_ask_disclosure_refresh`, plus four board refreshes at 600 s). ⚠ **This does NOT make them safe to strip** — the load-bearing warning above applies to the **75 declaring 30–120 s**, which are exactly the ones the gateway still lets through. **The two groups need opposite treatment and the 120 s line is what separates them.**

  ⓘ **It also gives six failing pipelines ONE root.** `upstream request timeout` is the gateway's string, not Postgres's. Over 24 h: `run-insider-detectors` **5/24**, `lock-check-batch` **9/46**, `compute-allday-pack-ev` **6/46**, `allday-unmapped-resolver` **8/76**, `populate-pinnacle-wmc-fmv` **2/23**. **One ceiling, six symptoms.** ⚠ Their `duration_ms` exceeding 125 s does not contradict it — several issue one RPC per collection, so a tick can burn ~120 s more than once (`lock-check-batch` avg 142 s, max 295 s, and its error names two collections).

  ⓘ **Mechanical note:** a function created with `execute_sql` is **invisible to PostgREST until the schema cache reloads** (`PGRST202 … no matches were found in the schema cache`); `NOTIFY pgrst, 'reload schema'` fixes it in seconds. That asymmetry is exactly why `apply_migration` causes the documented PGRST002 burst and `execute_sql` DDL does not — only one of them reloads.

- ⚠ **`match-topshot-players` HAS FAILED 100% OF ITS DAILY RUNS SINCE 2026-08-14 AND NOTHING WATCHES IT — and it hid because its healthy state and its broken state are identical on the metric everyone reads (found 2026-08-16 by sweeping `pipeline_runs_daily` for sustained-zero-output pipelines, not by an alert).** Verified live: 08-11/12/13 `ok`, `rows_found` **1417**, `rows_written` **0**; 08-14/15/16 **FAIL**, `rpc_failed: upstream request timeout`, ~126 s. It is on **no `pipeline_cadence_watchlist` arm**. ⚠ **`rows_written = 0` IS NOT THE BUG, BUT THE REASON GIVEN FOR IT — BY THE FILING AND BY THE FIRST VERSION OF THIS BULLET — IS WRONG, AND THE CORRECTION CHANGES THE RECOMMENDATION (measured 2026-08-16).** Both said the residual 1,417 names are the leftovers after "every uniquely-matchable name was aliased long ago". **Nothing was ever auto-aliased: `nba_player_aliases` holds 7 rows and ALL 7 are `source = 'manual'` — there is not one `source = 'auto'` row in the table**, and `auto` is the only source this function writes. **So it has produced zero output for its entire existence, not zero output *lately*.** The mechanism is its INPUT: it matches against `nba_players`, which holds **174 players across 19 of 30 teams, last synced 2026-05-07 — 101 days stale**. Against ~1,417 distinct Top Shot names, almost nothing *can* reach `candidate_count = 1`, so `rows_written = 0` is correct but for the opposite reason to the one recorded. **A pipeline correctly reporting "nothing is auto-resolvable" is byte-identical, on throughput, to one that has stopped running** — so this had to be found on `ok`/`last_error`, never on `rows_written`. ⚠ **It did not "break" on 08-14; it crossed a line it had been approaching for weeks** — healthy durations swung **12.8 s → 113.4 s** against a 120 s ceiling, tracking whatever else was competing for IO, and `wallet_moments_cache` only grows, so expect it to stay failing. Its first statement alone seq-scans **1.67 M** rows (563 k discarded by filter), reads ~**827 MB** off the IO-budgeted instance and spills a **70 MB** external merge sort, for **32.7 s** — with the planner off by **3×** on its row estimate. ⚠ **Its declared `statement_timeout=300s` is inert (see the bullet above), so raising it is the one guaranteed no-op.** Preferred fix, no schema change and no write cost: `owners` is a `COUNT(DISTINCT wallet_address)` computed for **every** distinct player name but consumed only for the `needs_review` ordering, so resolve against `nba_players`/`nba_player_aliases` FIRST and count owners only for the small unresolved remainder. ⚠ **The obvious index (`collection_id, player_name, wallet_address`) is deliberately NOT the recommendation** — wmc already carries 14 indexes over ~1.6 GB and is the most write-heavy table on the platform, the same reason `fmv_confidence` was left unindexed. ⚠ **BUT DO NOT SHIP THAT PERF FIX FIRST — IT CANNOT PRODUCE A SINGLE ALIAS, BECAUSE THE STARVED INPUT IS UPSTREAM AND THESE ARE ONE INCIDENT, NOT TWO.** `nba_players` is written by **`sync-nba-projections`** — the pipeline in Known issues #8 that has failed 100% of its runs for 13 days on a sports-proxy **403**. So one root cause has three downstream symptoms that were being triaged separately: the projections are 27.4 days stale, the **player catalogue is 101 days stale at 174 players / 19 of 30 teams**, and this matcher grinds 1.67 M rows a day against that stub and has produced **zero** auto-aliases ever. **Fast Break reads the same catalogue** (`app/api/fast-break/{today,uses,optimize}`), so it is running on a 19-team roster. **The lever is the 403, not the query plan** — optimizing this function would change its runtime and nothing a user can see. ⚠ The perf restructure remains correct and worth doing *after* the catalogue is fed; **it was deliberately NOT shipped this pass** because (a) it is unverifiable here — the measurement query for its own inputs **timed out at the 60 s MCP budget**, which is itself a demonstration of the cost, and shipping an unmeasured change to the platform's most write-heavy table on a saturated instance is what this file warns against, and (b) the function is **NOT PINNED and has no committed migration**, so changing it also means authoring a snapshot for a definition nobody could verify. ⚠ The fix is in the **DB function**, not the `supabase/functions/match-topshot-players` edge function, so it carries no `import_map` redeploy risk. Filed: [inbox 2026-08-17T0200Z](../../docs/overnight/inbox/2026-08-17T0200Z-match-topshot-players-has-failed-every-run-since-08-14-and-its-300s-budget-is-inert.md).
- ⚠ **`rows_written = 0` IS A NULL INSTRUMENT WITH THREE INCOMPATIBLE MEANINGS, AND THE "FIND INERT CRONS" SWEEP CANNOT TELL THEM APART — all three were found on 2026-08-16, by the same sweep, within hours of each other.** A `sum(rows_written) = 0 over 14 days` query returns a tidy ranking that reads as a retirement list. It is not one:
  | pipeline | what 0 meant | the pipeline was |
  |---|---|---|
  | `match-topshot-players` | **CORRECT** — nothing was auto-resolvable, by design | **BROKEN** (100% timeouts since 08-14) |
  | `drain-fmv-cold-tail` | **WRONG** — the `pipeline_runs` insert omitted the column; real count sat in `extra.results[].data.processed` (live: 63, 16, 12, 11, 9, 5, 2) | **HEALTHY**, repricing 5–71 editions a tick |
  | `sync-nba-projections` | **CORRECT** — there was genuinely nothing to write | **FAILING** on a real upstream 403 |

  ⚠ **The near-miss is the point: that sweep ranked `drain-fmv-cold-tail` near the top of the "inert" list at 614 runs / 120 minutes, and it is a live FMV WRITER** — it inserts `algo_version = 'cold-tail-1.0'` snapshots whose confidence labels feed the roadmap's headline HIGH/MEDIUM-share accuracy metric. Retiring it on that evidence would have silently degraded the platform's headline number. **Read `extra` and `last_error` before concluding a pipeline does nothing, and never retire on `rows_written` alone.** ⚠ **`ok` does not rescue you either** — it is `true` for the healthy-but-unreported case and `true` for the correctly-idle case. The only sound reading is per-pipeline: find where the work is counted, which for `after()`-based routes is usually `extra`. (Fixed for `drain-fmv-cold-tail` in `3a41f56e`. ✅ **`pinnacle-listings-retry` was investigated as a possible fourth and SETTLED 2026-08-16 — NOT a defect, do not "fix" it.** Reading the route end to end: `rowsFound = queue.length` and `rowsWritten++` fires only on the `cached_listings_v2.edition_id` backfill, which **is** the product write. The other two updates per tick are on `listing_resolution_failures` — setting `resolved_at` and bumping `retry_count` — i.e. bookkeeping on the retry QUEUE itself. So `rows_written: 0` correctly means "no edition_id was backfilled this tick", and counting queue bookkeeping as product rows would make the metric *less* honest, not more.)
  ⚠ **`ok = false` IS OVERLOADED THE SAME WAY, so the mirror sweep ("rank by failure rate") mis-reads too.** `reconcile-saved-wallet-stats` reports **78.1% "failed"** over 14 days — every one of them `soft_deadline_reached_partial_sweep_committed`, on runs that WROTE rows (live: 23, 6, 16). That is the procedure's designed graceful degradation: a soft deadline with per-wallet `COMMIT`s, so a "failure" is a partial sweep whose work is durably committed and whose next tick resumes. **It is making progress on 78% of the runs a failure-rate ranking calls broken.** (Worth knowing rather than fixing: a 78% soft-deadline rate does suggest it is under-provisioned for its window, but it never loses work.)
  ⚠ **And the reason these keep being found by accident is that the watchlist does not cover them: 139 pipelines ran in the last 14 days and only 86 are on a `pipeline_cadence_watchlist` arm (61.9%).** Seven unwatched pipelines are failing ≥25%: `sync-nba-projections` **87.6%** · `reconcile-saved-wallet-stats` 78.1% · `allday-unmapped-resolver-tail` 34.3% · `refresh_wmc_fmv_changed` 32.6% · `refresh_wmc_fmv_drift_active` 32.2% · `allday-buyer-backfill` 31.3% · `golazos-buyer-backfill` 28.6%. ⚠ **Three of those seven are already documented in this file as EXPECTED** (the tail resolver's exhausted backlog, and the two `wmc` FMV propagators whose cost is the price of the denormalization), and a fourth is the soft-deadline case above — **so the raw ranking is ~57% false positives, which is precisely why nobody acts on it.** The two worth triaging are `sync-nba-projections` (Known issues #8) and the two buyer-backfills, which are unexamined.
- ⚠ **AN EXPLICIT `NULL` FROM THE APP DEFEATS A COLUMN `DEFAULT`, so "add a DEFAULT and backfill" is often INERT ON THE MAIN WRITE PATH while looking correct in the schema (2026-08-16).** Postgres applies a `DEFAULT` only when the column is OMITTED from the INSERT; `... ?? null` sends an explicit NULL and wins. This killed the obvious implementation of the RPC-logo avatar default — `app/api/profile/bio/route.ts` POSTs `avatar_url: avatarUrl ?? null`, so `ALTER COLUMN … SET DEFAULT` would have fired for **no new signup**, leaving a permanent backfill obligation to paper over a default that reads as working. **Check what the writer actually sends before reaching for a column DEFAULT**; a render-time default also keeps NULL meaning "the user has not chosen", which is the only way to later answer "who has actually personalised?" — a distinction a backfill destroys irreversibly.
- ⚠ **EVERY `apply_migration` CAUSES A ~10-20 SECOND BURST OF USER-FACING 500s. Prefer a low-traffic window** (measured 2026-08-13). Applying a migration invalidates PostgREST's schema cache, and every request served during the re-introspection fails `PGRST002 — Could not query the database for the schema cache. Retrying.`, which the entity/pack pages surface as a thrown "… detail unavailable" and a 500. **Measured causally, not inferred:** every schema-cache event in a 24 h window fell inside ONE 11-second span (17:20:15/:21/:23/:26 Z, across the pack, edition and player pages) and `schema_migrations` shows the migration applied at **17:20:05 Z** — first error +10 s, last +21 s — a handful of real visitors caught per reload, across many migrations (3 landed within 11 minutes on 08-13 alone). ⚠ **THE CAUSAL MEASUREMENT ABOVE STANDS; ITS SENTRY ATTRIBUTION WAS WRONG AND IS CORRECTED HERE (2026-08-15).** This bullet used to call the burst "the entire explanation for `JAVASCRIPT-NEXTJS-1Z` accruing 81 users / 84 events". It is not. Read live from Sentry, **`NEXTJS-1Z` is titled `pack detail bundle unavailable: TimeoutError: The operation was aborted due to timeout`**, culprit `GET /[collection]/pack/dist/[distId]`, now **86 users / 92 events** and still firing — an ABORT on a slow read, not `PGRST002`. **Sentry groups by title, so schema-cache events were never in that issue at all.** The tell was inside this very file: a second bullet, written a day later, independently identified `NEXTJS-1Z` as *"pack detail bundle unavailable, 40 users"* and profiled the RPC at 18,951 ms cold — **two bullets attributing one issue ID to two different causes, and neither noticed the other**. ⚠ **The generalizable trap: an issue ID is not a diagnosis.** Both attributions were reached by finding a real defect and then reaching for the biggest ID on the board to attach it to; the migration bursts and the pack-detail timeouts are both real and are different incidents. **Read the issue TITLE and culprit before claiming an ID** — one query would have caught this a day earlier, twice. ⚠ **`rpcWithRetry` does NOT save you from the schema-cache burst either** — it classifies `PGRST002` as transient (correct, `4f303102`) but retries 3× at 50 ms + 200 ms ≈ **250 ms**, entirely inside the first quarter-second of a twenty-second outage. ⚠ And do **not** "fix" it by making those pages fail soft — the throw is deliberate (deep-audit D10) so a transient failure renders a retryable error boundary rather than a soft-404 that invites Google to drop a real page. Batching several migrations into one window costs one burst instead of N. Full analysis + the filed options: [inbox 2026-08-13T2320Z](../../docs/overnight/inbox/2026-08-13T2320Z-the-schema-cache-500s-are-self-inflicted-by-our-own-migrations.md).
- ⭐ **THE BURST IS NOT ONLY USER-FACING — IT LANDS INSIDE `wallet-backfill*` AS `rows_lost`, AND THE WORST WINDOW IS NAMEABLE (measured 2026-08-29).** `PGRST002` hits `upsert_wmc_batch` exactly like it hits a page read, and the wallet-backfill wrapper records it as data loss rather than as an outage: `wmc_upsert_chunk_failures=2 rows_lost=400 first=Could not query the database for the schema cache` at **01:29:03.974Z / 01:29:04Z**, against migration `20260829012854` applied at **01:28:54Z** — nine seconds. Two runs, **511 rows**. ⚠ **So "prefer a low-traffic window" has a specific meaning here: the `wallet-backfill*` waves run ONLY in UTC hours 0, 1, 12 and 13** (`app/api/seed-wallet-refresh/route.ts` gates on `utcHour % 12 >= 2`), and those are the hours where a migration costs internal rows on top of visitor 500s. ⚠ **Suggestive, not proven — n is 1 in-wave against 3 out-of-wave.** Three migrations applied the same night at 01:39Z, 02:49Z and 04:15Z (all outside a wave) produced **zero** schema-cache failures anywhere in `pipeline_runs`. The mechanism is not in doubt; the effect size is one observation. 👉 **Rule of thumb: apply migrations OUTSIDE UTC 00–01 and 12–13, and batch them.** ⚠ And note the reporting shape — a burst that lands here is recorded as `rows_lost`, **not** as an error anyone would attribute to a migration.
- ⚠ **When an error looks like random infrastructure noise, check whether it tracks OUR OWN migrations or deploys before blaming the platform.** The finding above came from correlating two clocks nobody had put side by side: Sentry event timestamps and `supabase_migrations.schema_migrations.version`, which encodes the applied time as `YYYYMMDDHH24MISS`.
- ⚠ **VERIFYING A DB CHANGE THROUGH A PUBLIC ROUTE: a BYTE-IDENTICAL response is the signature of a CACHE HIT at least as much as of a correct change (2026-08-15, `fe30d979`).** After repairing the two deals views I confirmed the board by re-fetching it and getting "byte-identical 30,856 bytes" — **but the response also carried an `elapsed_ms` identical to the millisecond (5833 twice), which no independent execution produces.** I had compared a cached response to itself. Every `/api/public/insights/**` route sets a public `s-maxage` of 300–3600 on success, so on those routes the cache reading is the LIKELIER one. **Re-run with a cache-busting query param** and confirm the payload genuinely re-executes (it did: same row set, `elapsed_ms` 5455). The generalizable tell is a metric that *cannot* repeat exactly — a duration, a timestamp — coming back identical.
- ⚠ **When pages are timing out, ask `pg_stat_statements` what is eating the IO budget BEFORE optimising the page that hurts.** Ranking by `shared_blks_read` on 2026-08-14 put a **backfill** first at **113 GB** — the timeouts were collateral. This has now paid off twice: the same method found `count_insider_detector_candidates` burning ~27 GB/day of pure telemetry with no consumer.
  ⚠ **And the defect is often the CALLER'S ARGUMENT, not the function.** `backfill_wmc_fmv_confidence` was fine; the cron passed it a collection whose backlog was exhausted, so its `LIMIT`-ed batch query — on a column deliberately left unindexed — seq-scanned all **2.3 GB** of `wallet_moments_cache` finding nothing, **every five minutes**. Same function unscoped: **87 buffers, 45 ms**; live ticks went **2:13 → 3.5 s** for one `cron.alter_job`. **A batch query that stops early only stops early when the batch EXISTS** — the moment a queue drains, its "cheap" scan becomes a full one, which is also why such a job must be RETIRED when it finishes rather than left running (the tell is the duration climbing back from seconds to minutes).
  ⚠ **Test the tidy hypothesis before acting on it.** The obvious story there was zombie rows that could never satisfy the join; a 200-row sample said **200/200 would be updated**. A cheap sample is worth more than a plausible mechanism.
- ⛔ **AN EXPENSIVE-LOOKING FUNCTION IS NOT A COST UNTIL YOU HAVE NAMED ITS CALLER — this is the rule the bullet above is missing, and it cost a full afternoon on 2026-08-17.** A session diagnosed, fixed, applied, committed and reported an early win on `get_unmapped_resolver_targets`, then discovered it has **ZERO callers**: 0 calls in `pg_stat_statements` over 5.6 days with **`pg_stat_statements_info.dealloc = 0`** (so the absence is real, not a truncated window), no `pg_proc.prosrc` caller, no `cron.job.command`, no view definition, no repo reference — and `unmapped_sales_resolution_failures`, which its retry guard reads, is **entirely empty**. The change was correct on its own terms and a **NO-OP in production**; the causal story in its header ("re-scanned the same slice every 30 min", "inflow outpaced outflow") described properties of the function's **OUTPUT**, from which a consuming caller was *assumed*. **Measuring what a function returns tells you nothing about whether anything calls it.** ⚠ **`pg_stat_statements` ALONE IS NOT ENOUGH, in either direction, because `track = top` records only top-level statements**: a nested caller is invisible, so zero calls does not prove orphanhood, and `pg_proc.prosrc` is the load-bearing check. Pair this with the four-source orphan rule under Security posture — that one guards against wrongly declaring an orphan (**32 of 37** functions report zero DB callers yet are live product RPCs called from Next.js); this one guards against wrongly declaring a *cost*. **Both errors are one missing step: name the caller before you touch the function.** ⚠ Note what a purpose-built index does and does not tell you: `idx_unmapped_sales_tail_resolver_targets` correctly pointed at the predicate to use, but it was built for the **tail** resolver — the component that actually runs — so it identified the live path while the fix was applied to the dead one. **A design document tells you the right shape, not the right object.**

  ⚠ **ALSO DISPLACED VERBATIM FROM that same rule (2026-08-23), to make room for the production-caller control below — two fragments, in full:** *"(8 artifact-only views; a sweep without it breaks 3 live boards)"* (i.e. when enumerating callers, the Cowork artifacts' HTML is a source outside BOTH the repo and the catalogue, and a sweep that omits it breaks three live boards) and, on the seventh source, *"; the 08-22 canary greps ZERO callers, runs every 30 min"* (an EDGE function invisible to all six sources *and* to `cron.job`, because cron-job.org drives it).

## 🚨 `EXCEPTION WHEN OTHERS` DOES NOT CATCH A STATEMENT TIMEOUT — so an isolation block built on it cannot survive the only failure this instance actually produces (promoted here 2026-08-26)

**PostgreSQL: *"the special condition name `OTHERS` matches every error type EXCEPT `QUERY_CANCELED`
and `ASSERT_FAILURE`"*, and a `statement_timeout` raises exactly `query_canceled` (57014).**
Re-verified on this instance 2026-08-26, both directions, on a scratch function dropped afterwards:

| probe | result |
|---|---|
| `BEGIN … EXCEPTION WHEN OTHERS` around a cancelled `pg_sleep` | **escaped the handler** — 57014 propagated |
| the same block with `WHEN query_canceled THEN` | **caught** |

⚠ **THIS IS NOT NEW — it was established 2026-08-15 — AND IT RECURRED ANYWAY, WHICH IS WHY IT IS
HERE.** The original analysis lives in
[trust-board-and-safety.md](trust-board-and-safety.md) under the 999-sentinel bullet, filed as a
**trust-board** fact. It is not a trust-board fact; it is a **PL/pgSQL** fact. Eight days later
`refresh_series_detail_rollup` shipped a `BEGIN … EXCEPTION WHEN OTHERS` block whose stated purpose
is *"Isolated so it cannot take the job down"* — and it is structurally incapable of catching the
only error that job has ever had. ⭐ **A rule filed under the subsystem where it was found is
invisible to the next subsystem that needs it.**

**The two live instances, measured 2026-08-26:**

- **`refresh_series_detail_rollup`** — 72 ticks over 3 days, **71 ok / 1 failed**, and the failure is
  `57014` propagating **from the protected line itself** (`refresh_edition_fmv_current() line 8` →
  `refresh_series_detail_rollup() line 16 at assignment`). The isolation is claimed to keep 26
  indexable series pages served from the previous hour's copy; on a timeout it does not run.
- **`public_board_liveness_sweep`** — its per-board handler comments *"A TIMEOUT is SLOW, not
  EMPTY"* and branches on `v_sqlst = '57014'`. **`public_board_liveness_history` holds 1,601 rows
  with ZERO `err` values ever recorded, and zero beginning `57014`.** That branch has never fired
  and cannot. ⓘ **No outcome impact** — the sibling `elapsed_ms > max_ms` path still counts slow
  boards — but it reads as a safety net that is not one.

⛔ **DO NOT "FIX" IT BY WIDENING THE CLAUSE TO `WHEN query_canceled OR OTHERS`.** That was applied
and reverted on 2026-08-15 on three measurements, the decisive one being that **after a cancel is
caught the timer is NOT re-armed** (probe: first `pg_sleep(3)` cancelled and caught, second ran to
completion unbounded). Catching the cancel buys a reachable handler at the price of running
everything after it **with no bound at all**, holding a pooled connection on the instance whose
saturation caused the timeout — **a bounded failure traded for an unbounded one.**

➡ **The remedy is structural and it is the same one every time: give the fragile step its own
TOP-LEVEL statement** (a separate pg_cron entry), so it gets a fresh budget, its timeout cannot
reach its neighbours, and `cron.job_run_details` names it directly. ⚠ Check `cron.job.username`
first — a `cron_heavy`-owned job cannot be rescheduled from any session-reachable role.

## 🚨 A ROUTINE WITH AN ATTACHED `SET` CLAUSE CANNOT `COMMIT` — and that makes SECURITY DEFINER and transaction control MUTUALLY EXCLUSIVE here (2026-08-23, re-confirmed 2026-08-26)

**PostgreSQL refuses `COMMIT`/`ROLLBACK` inside any routine carrying an attached `SET` config clause**
(`SET search_path = …`), with `2D000 invalid transaction termination`. It has cost once and nearly cost twice:

- **It cost, 2026-08-23.** A `search_path`-hardening pass ran `ALTER PROCEDURE
  public.reconcile_all_saved_wallet_stats(int,int,int) SET search_path = public` on a procedure that
  **COMMITs per wallet**. Every tick after the ALTER died at `line 30 at COMMIT` — not a timeout, an
  immediate error before any work. The hourly saved-wallet cache stopped refreshing. ⚠ **The hardening
  was right in general and the wrong tool on this one routine.**
- **It nearly cost again, 2026-08-26.** The board-watchdog filing prescribed converting
  `public_board_liveness_sweep` to *"a PROCEDURE with a `COMMIT` after each board"*. That function is
  **`prosecdef = true` with `proconfig = {search_path=public, pg_temp}`**, so the conversion as written
  would have raised `invalid transaction termination` on the first COMMIT and taken the watchdog **fully
  dark** — worse than the one-tick-in-eight it was meant to fix.

⭐ **The check that settles it in one query, and it is a SHAPE, not a rule to remember:** every routine on
this database that actually commits reads **`prokind='p'`, `prosecdef=false`, `proconfig=null`**
(`reconcile_all_saved_wallet_stats`, `rpc_trust_health_precompute_refresh_p` — both, 2026-08-26). **If a
routine needs transaction control, it cannot also carry a pinned `search_path`, and therefore should not be
SECURITY DEFINER.** Read `prosecdef` and `proconfig` from `pg_proc` **before** designing any per-item-commit
fix; a durability design that assumes COMMIT is available is blocked before it is written.

⚠ **And you cannot test the construct through `execute_sql`** — it wraps every statement in a transaction, so
a scratch `CALL` returns the same `2D000` from the **harness**, which is not evidence about the routine. Same
limitation as `CREATE INDEX CONCURRENTLY`: a real answer needs a one-statement pg_cron job, or the live
`proconfig`/`prosecdef` read above, which is cheaper and sufficient.

➡ **The usual escape is not a COMMIT at all: SLICE THE SCHEDULE.** Each pg_cron tick is already its own
transaction, so running a rotating sweep more often with a smaller budget gives the same "completed work
survives a timeout" property with no procedure conversion, no `search_path` strip and no privilege change.
Weigh it against the added IO on this IO-bound instance (R46).

## ⚠ A FUNCTION'S `SET statement_timeout` IS INERT **ON THE pg_cron PATH** — and `current_setting()` REPORTS THE LIE BACK TO YOU (proven 2026-08-26, **SCOPED 2026-08-27 — read the correction below FIRST**)

> 🚨 **THE ORIGINAL HEADING OF THIS SECTION SAID "DOES NOTHING — in EITHER direction". THAT IS
> WRONG AND IS RETRACTED.** The A/B run on Trevor's box on 2026-08-27 (recorded ~140 lines above,
> *"`proconfig` IS PATH- AND DIRECTION-DEPENDENT"*) shows that **via PostgREST a HIGHER declaration
> RAISES the ceiling** (30 s → 60 s, measured), so **122 functions declaring more than
> `service_role`'s 30 s are LOAD-BEARING and must not be stripped as no-ops.** ⛔ **Do not act on
> this section without reading that one.** What survives here: the declaration is inert **on the
> pg_cron path** (44/248 overruns), a LOWER declaration is inert on both paths, and the
> `current_setting()` trap below is real on every path.
>
> ⭐⭐ **AND THE REASON I OVER-GENERALISED IS NAMED BY A HEADING IN THIS VERY FILE, ~78 LINES BELOW:
> "A CONTROL THAT DOES NOT USE THE PRODUCTION CALLER IS NOT A CONTROL (2026-08-23)."** My four
> probes below sent `SET …; SELECT fn()` as **one multi-statement batch through the admin SQL
> path** — a caller no production code uses. The A/B that settled it used `SECURITY INVOKER`
> functions POSTed to `/rest/v1/rpc/…` with the service-role key, i.e. **exactly how every
> `supabaseAdmin` RPC actually runs.** ⭐ **A synthetic path can prove a mechanism and still be
> silent about the ceiling that binds in production — and a result from one is not licence to say
> "in either direction" about paths you did not test.**

**`statement_timeout` arms a timer ONCE, when the top-level statement begins, from the value in
effect at that moment. Changing the GUC inside a function — by `proconfig` (`SET … TO …` on the
routine) or by `set_config(…, is_local => true)` in the body — does NOT re-arm it.**

Proven by four probes on this instance, not inferred — ⚠ **all four issued through the admin SQL
path, which is the confound named above; they establish the timer mechanism, not the production
ceiling:**

| probe | setup | result |
|---|---|---|
| **A — can proconfig RAISE?** | fn with `SET statement_timeout TO '10s'`, sleeps 4 s, session at **2 s** | ⛔ **killed at 2 s** |
| **B — can `set_config(…, true)` RAISE?** | same, set from inside the body | ⛔ **killed at 2 s** |
| **C — can proconfig LOWER?** | fn with `SET statement_timeout TO '1s'`, sleeps 4 s, session at **20 s** | ✅ **FINISHED** |
| **D — does a leading `SET` work?** | `SET statement_timeout='2s'; SET …='9s'; SELECT pg_sleep(4)` | ✅ completed, effective `9s` |

🚨 **In probe C, `current_setting('statement_timeout')` read `1s` from inside a function that had
already been running for four seconds.** ⭐ **So the obvious diagnostic — ask the session what
timeout it is under — returns a value that is true about the GUC and false about the behaviour.**
That is why this class of bug survives: every check anyone can run says the setting is applied.

⭐ **THE ONLY FORM THAT WORKS is a leading `SET` as its own TOP-LEVEL statement**, which is why the
pg_cron two-statement command works:

```sql
SET statement_timeout = '900s'; SELECT public.my_heavy_function();
```

pg_cron runs both in one implicit transaction with the `SET` as its own top-level command, so the
session value is already changed when the `SELECT` arms its timer.

**What actually governs a pg_cron job with no leading `SET`: the job's ROLE.** `cron_heavy.rolconfig`
is `statement_timeout=600s`; `postgres` has none, so those fall to the cluster default. Measured
2026-08-26: **48 active jobs declare a proconfig timeout that is inert** — and the fiction runs both
ways, with **26 `cron_heavy` jobs declaring 60–480 s while actually free to run to 600 s.**

⛔ **Do not read a routine's `proconfig` as a budget** — not in review, not in an incident, not when
tuning. ⛔ **And do not "make the declarations real" as a batch:** several jobs have SUCCEEDED well
past their declared value (jobid 217 declares 120 s and has succeeded at 595 s), so enforcing them
would convert working runs into failures. See known-issues **#43**.

## 🚨 A CORRELATED SUBQUERY AGAINST A `DISTINCT ON` VIEW RE-MATERIALISES THE WHOLE VIEW ONCE PER OUTER ROW (measured 2026-09-02)

**The shape.** `pack_ev_latest` is a view of `pack_ev_history` with
`DISTINCT ON (pack_listing_id) … ORDER BY pack_listing_id, snapshotted_at DESC`. A
scalar subquery correlated on `dist_id` cannot push that predicate through the
DISTINCT, so Postgres evaluates the ENTIRE view for every outer row.

Measured in `refresh_challenge_costs()` (EXPLAIN ANALYZE, BUFFERS, warm, **31** outer
rows):

| form | time | buffers |
|---|---|---|
| correlated scalar subquery | **40,716 ms** | **21,094,324** |
| hoisted once into a temp table | **1,220 ms** | **681,430** |

**31× the buffers, 33× the time, for 31 rows** — the multiplier is exactly the outer
row count, which is the tell. The view's own `pack_ask_state` `NOT EXISTS` subplan ran
**3,849,487 times** and accounted for 11.4M of those buffers on its own.

⚠ **This was 99.7% of that function's cost and the arm produced NOTHING.** `rows=0` on
all 31 loops: of the 29 distinct `challenges.reward_pack_dist_id`, all 29 are in
`pack_distributions` and **zero** have any row in `pack_ev_history` — challenge reward
packs are rewards, not listings, and that table is keyed on `pack_listing_id`. Checked
both alternative explanations first: not the view's filters (the base table has no rows
either) and not a vocabulary mismatch (same numeric-string id space, and the history's
max dist id is *higher* than the challenges').

⛔ **The fix was to HOIST, not to DELETE the arm.** It is empty for a structural reason
today, but a reward pack that ever gets listed would populate it, and the cost was never
the arm — it was evaluating it 31 times. Pinned by
`__tests__/challenge-costs-pack-ev-lookup-stays-hoisted.test.ts`, because the correlated
form is the one a reader reaches for: shorter, natural next to the sibling COALESCE
arms, and **nothing about it looks expensive**.

⚠ **The consequence was a silent daily outage, not slowness.** pg_cron jobid 87
`rpc-refresh-challenge-costs` died at exactly **120.0 s** on **8 of its last 52 runs
(15.4%)**, and both UPDATEs live in one `SELECT refresh_challenge_costs()`, so the
timeout rolled back the cost refresh as well — on those days *nothing* was refreshed.
⭐ **120 s is this cluster's DEFAULT `statement_timeout` (`120000`), which is what a
`postgres`-owned pg_cron job runs under** — known-issues #43 established that those 12
jobs "run at the cluster default" without naming the number. Now it is named.

⚠ **AND THE FIRST VERSION OF THE MIGRATION'S OWN CONTROL WAS WRONG — it asserted that
no `cached_reward_value` changed, and 18 of 31 changed.** The stored values came from
the last SUCCESSFUL cron run, a day or more earlier; arms 2–4 read `pack_purchases` and
`fmv_snapshots`, which move daily. **A before/after comparison spanning a refresh window
measures the DATA moving and reports it as a code difference.** The honest control was
narrower: only arm 1 changed, and the two forms of arm 1 differ only where a reward dist
appears in the view — so `overlap = 0` is a complete equivalence proof, at 1.2 s instead
of the 40 s an old-vs-new A/B would have cost. Migration `20260902120329`.

## 🚨 A GATEWAY `504 upstream request timeout` ON A **WRITE** RPC IS A ROLLBACK — you pay the full cost and keep nothing (proven by control 2026-09-02)

The ~120 s Supabase gateway cap is already documented above (known-issues #43, third
ceiling). What was **not** written down is what happens to the WORK when it fires, and
the existing prose could be read the wrong way: the `match-topshot-players` entry notes
that "the statement keeps running server-side after the client has already given up",
which is true about **cost** and says nothing about **commit**.

**It does not commit.** The control is an audit table the function writes on its own
success path, compared day-by-day against `pipeline_runs_daily.last_error` for
`topshot-misattrib-drain` (daily, Vercel cron → PostgREST → `remap_topshot_from_onchain_map()`):

| day | `pipeline_runs` error | rows added to `audit_topshot_sale_drain_remap_20260621` |
|---|---|---|
| 08-23 | `rekey: upstream request timeout` | **0** |
| 08-24 | `rekey: upstream request timeout` | **0** |
| 08-25 | `rekey: upstream request timeout` | **0** |
| 08-26 | `rekey: upstream request timeout` | **0** |
| 08-27 | (ok) | 673 sales / 107 moments |
| 08-28 | `rekey: upstream request timeout` | **0** |
| 08-31 | `HTTP 530 ×3` (GQL leg only — the re-key ran) | 335 sales / 7 moments |
| 09-01 | `HTTP 530 ×3` | 60 sales |
| 09-02 | `HTTP 530 ×3` | 70 sales |

Five for five: every gateway timeout wrote **nothing**. The connection close propagates
to the backend, the transaction aborts, and the ~1.4 GB of reads it had already done on
a **22 MB/s** instance buys zero rows.

⚠ **Both halves are true and they compound — this is the worst possible shape.** The
statement burns a pooled connection and the IO budget for its full server-side duration,
*and* the result is discarded. Treat any `upstream request timeout` on a write path as
**"it did not happen"**, and never as "the response was lost but the write landed".

⚠ **The read/write asymmetry is why this was missable.** On a READ RPC a gateway timeout
costs you the answer and nothing else, so the six `upstream request timeout` pipelines
already catalogued above read as "slow, needs work". On a WRITE RPC the same string means
the pipeline **is not doing its job at all** on those ticks — and if the work is
idempotent (as this re-key is) the next successful run silently catches up, so the
backlog never grows and no downstream metric ever shows it. **Nothing but the audit table
could tell the two apart.**

⭐ **VERIFIED SAME DAY, AND THE NUMBER IS THE ARGUMENT.** The first successful run of the
relocated job (`run_topshot_onchain_rekey()`, 2026-09-02 11:35:48→11:37:04Z) took
**75,803 ms** — `ok`, `rows_written 0`, `moments_deferred_conflict 10`. That is **63% of
the ~120 s gateway cap and 13% of `cron_heavy`'s 600 s**. A job sitting at 63% of its
ceiling does not fail half the time because it is broken; it fails half the time because
IO contention is worth more than 37%.

⚠ **AND ONE SCOPE CORRECTION, LEARNED BY GETTING IT WRONG IN THE SAME HOUR: "the client
gave up" DOES NOT IMPLY A ROLLBACK, and the discriminator is WHICH client.** That same
call was issued through the Supabase **MCP** `execute_sql` tool, which gave up at its own
**60 s** budget. The statement kept running and **COMMITTED at 75.8 s** — the row above is
its row. I read `pipeline_runs` at ~11:36, saw zero rows, and briefly recorded that as a
second replication of the rollback finding. It was a **reading taken while its subject was
still changing**, which this file already warns is not a reading at all.
- **Supabase gateway 504 (`upstream request timeout`, PostgREST path): ABORTS.** Evidence
  is the 5-for-5 audit-table control above, not a mechanism.
- **MCP `execute_sql` 60 s tool timeout: DOES NOT ABORT.** Evidence is the committed row.
👉 So never "just run it once to check" through MCP and read the absence of a row as
proof of anything — **wait past the statement's own duration before concluding**, and do
not carry either result across to the other layer.

👉 **The fix is the CALLER, not the clock.** `cron_heavy` carries
`statement_timeout = 600s` as a role config, five times the gateway cap and with no
gateway in the path at all, which is why the sibling re-key (jobid 62) has never had this
problem. Moving the call there is a scheduler change, not a query change — see
[cron-and-schedulers.md](cron-and-schedulers.md) for the worked example (jobid 434).
⛔ **Do not reach for "make the query faster" first**: measured the same day, the sales
leg of that re-key scans 3,198,302 Top Shot rows for **174,820 buffers / 9.0 s warm**, and
the planner's hash join is the RIGHT plan — forcing the nested loop over the
per-partition `nft_id` indexes costs **1,315,991 buffers / 33.3 s**, 7.5× worse.

## 🚨 A PARTIAL INDEX WHOSE PREDICATE SAYS `col IS NOT NULL` ON A `NOT NULL` COLUMN IS UNREACHABLE ON PG 17 (2026-08-23)

This DB is **PostgreSQL 17.6**. PG 17 removes a redundant `col IS NOT NULL` qual when `col` is declared
`NOT NULL` — correct as a *filter*, but it happens **before partial-index predicate proving**, and the prover
reasons over clauses, not over column constraints. The index's own predicate then cannot be proven, so the
planner **drops it from the candidate set entirely**. It is not out-costed; it is invisible. It becomes
reachable again only if the query supplies some other **strict** clause on that column (`col = $1`,
`col <> $1`, …), because a strict operator clause does prove `col IS NOT NULL`.

- ⚠ **This is why `idx_sales_2026_fmv_recalc_window` has `idx_scan = 0` at 98 MB** while
  `fmv_recalc_edition_page` — the function it is named for, whose predicate it matches exactly — times out.
  Measured on `sales_2026`, same 30-day window, same 128,534 output rows, both plans non-parallel: as the
  function writes it, **50,471 ms / 97,669 buffers**; with one redundant `edition_id <> '000…'::uuid` added,
  **17,425 ms / 48,494 buffers** via `Index Only Scan` — **2.9× faster on 2.0× fewer buffers**. At the real
  90-day window the as-written form did not complete in 60 s (twice) against ~16 s reachable.
- ⚠ **The estimate over-promises: the planner said 7.4×, the measurement said 2.9×.** The index-only scan
  still did **46,625 heap fetches** — `sales_2026` is 99.7% all-visible *overall*, but the last 90 days are
  the part autovacuum has not caught up on, and that is exactly the range this query reads.
- ⚠ **`idx_scan > 0` DOES NOT MEAN REACHABLE.** `idx_sales_2026_top_sales_board` carries 502 recorded scans
  and is unreachable today (bitmap+sort at cost 28,149 where the index costs 9.75 once a strict qual on
  `edition_id` is added). **A scan count is a claim about the past.** The unused-index advisor is structurally
  blind to this class on exactly the indexes that used to work.
- **Controls, both directions, all measured:** same predicate shape on a NULLABLE column is chosen instantly
  (`sales_2026_tx_nft_sold_idx`, cost 0.55); a NOT NULL column whose predicate also carries a strict clause is
  chosen with no residual filter (`unmapped_sales_sold_at_unresolved_idx`, via `nft_id <> ''`); one index goes
  both ways in one session (`pack_drop_pool_edition_idx`: bare `IS NOT NULL` seq-scans, `edition_id = $1`
  index-scans); and an index with no `IS NOT NULL` conjunct at all is fine
  (`idx_sales_2026_ts_otherserial_cover`), which rules out `price_usd > 0` as the blocker.
- **Current population: 6 partial indexes in `public` carry the shape** (`pg_index.indpred` ×
  `pg_attribute.attnotnull`). Two measured unreachable, three reachable via a strict clause, one predicted
  unreachable and not measured (`idx_pinnacle_editions_set_name`). **The repair is free of behaviour change** —
  the conjunct excludes zero rows — but it is an index rebuild, so it is DDL: `CREATE INDEX CONCURRENTLY` is
  reachable here only via a one-statement pg_cron job, and every `apply_migration` costs a ~10–20 s
  `PGRST002` burst.

Full evidence, plans and the enumerated population:
`docs/overnight/inbox/2026-08-23T2130Z-postgres-17-makes-partial-indexes-with-is-not-null-predicates-unreachable.md`.

## 🚨 A CONTROL THAT DOES NOT USE THE PRODUCTION CALLER IS NOT A CONTROL (2026-08-23)

**Both Pinnacle TRADE cron jobs failed on EVERY run from creation and it went unnoticed for hours**, because the check that was supposed to prove they worked used the wrong caller.

    rpc-backfill-pinnacle-trade-acquisitions  (23 */3)    ERROR: permission denied for function
    rpc-backfill-pinnacle-trade-editions      (41 * * *)  ERROR: permission denied for function

⚠ **EXECUTE is checked against the CALLER even on a `SECURITY DEFINER` function.** Both were scheduled under `cron_heavy`. Their migrations did the correct anon-safety revoke — `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` — then `GRANT … TO postgres, service_role`. ⚠ **A new function gets `EXECUTE TO PUBLIC` by default and `cron_heavy` was silently relying on it**; revoking PUBLIC removed the scheduler's only grant and the explicit list did not name it. Measured: `has_function_privilege('cron_heavy', …)` was FALSE for both, and **TRUE for the sibling `backfill_pinnacle_mint_acquisitions`**, which is scheduled identically and works *only* because it still carries that PUBLIC grant.

🚨 **THE REASON IT SURVIVED "VERIFICATION": the functions were tested by calling them over the Supabase MCP, which connects as `postgres` — a role that HAS execute.** They returned clean JSON and were recorded as working. Neither writes `pipeline_runs`, so the permission failure happened *before* any logging and presented as **silence**, not failure; the session even reasoned "`updated: 0` is correct right now", which was true for entirely the wrong reason. **The only witness was `cron.job_run_details`, which nothing watches.**

⚠ **A concurrent session hit the IDENTICAL trap the same night** (`20260823032000_audit_20260823_series_rollup_cron_heavy_execute_grant.sql`). Two independent instances in one night is not a coincidence — it is the default behaviour of the correct anon revoke.

🚨 **FOURTH INSTANCE, 2026-09-02 — AND IT HAPPENED TO SOMEONE WHO HAD THIS PARAGRAPH
AVAILABLE AND DID NOT READ IT.** `run_topshot_onchain_rekey()` (jobid 434) shipped with the
correct `REVOKE … FROM PUBLIC, anon, authenticated` and no `cron_heavy` grant; its first
tick died in 0.0 s with the same `permission denied for function`. The migration that
shipped it (`20260902113501`) even asserts in its own header that "nothing said so" —
**which is false, and the correction belongs here rather than in that applied file: this
paragraph has said so since 2026-08-23.**

⭐ **THAT IS THE ACTUAL FINDING. Three documented instances did not prevent a fourth,
because the record is PROSE — read after a session already knows its topic — and the trap
fires at the moment you are thinking about anon safety, not about scheduling.** What was
missing was never knowledge; it was a CHECK. `check_cron_heavy_job_exec_drift()`
(migration `20260902113501`) is that check: it walks `cron.job` for active `cron_heavy`
rows, extracts every `public.<fn>(` named in each command, and returns
`{inspected, offenders}` — offenders being names no overload of which `cron_heavy` may
execute. `inspected` exists so a walk that matched nothing cannot read as a clean bill of
health. Live at creation: **inspected 56, offenders 0**.
✅ **AND IT IS WIRED, same session** — an unrun check is the shape this repo calls theatre.
It is an arm of `/api/smoke-test` (`cron_heavy can execute every function it is scheduled
to call`), which runs on **every push to `main`**, daily at 12:11 UTC via
`smoke-tests.yml`, and 6×/day on the Vercel cron `17 */4 * * *`. It is HARD (it pages), it
fails closed on any payload that is not `{inspected, offenders}`, and an `inspected` below
20 is reported as a BROKEN GUARD rather than a clean run. Still call it by hand after
creating any function you intend to schedule — same reflex as re-running
`check_secdef_anon_exec_drift()` — but nothing now depends on remembering to.

**THE RULE, both halves:**
1. **After scheduling any pg_cron job under a non-`postgres` role, assert `has_function_privilege('<role>', '<fn>(<args>)', 'EXECUTE')`** — scheduling a job does not imply permission to execute what it calls.
2. **Exercise it AS that role before calling it done**: `SET LOCAL ROLE cron_heavy; SELECT <fn>(…);`. Doing that here returned `updated: 1044` on the first successful run — the backlog the broken cron had silently accumulated.

⚠ **Generalises past pg_cron.** Any check run through a more-privileged path than production uses proves nothing about production: an MCP/`postgres` call for a `cron_heavy` job, a service-role query for an `anon` surface, a local run for a Lambda. **Ask which principal runs it in production, and use that one.**

⚠ **And the failure shape is the dangerous part**: a permission error on a function that does its own logging happens *before* the log, so it is indistinguishable from "there was nothing to do". Where a job cannot log its own failure, `cron.job_run_details` is the only instrument — check it.

  ⚠ **DISPLACED VERBATIM FROM CLAUDE.md's six-source caller rule (2026-08-22), condensed there to a pointer — the two clauses in full:** *"⚠ **A TRIGGER function has NO textual caller anywhere**: 33 of the 38 live attached ones read as dead without `pg_trigger` (2 delete). ⚠ `pg_stat_statements` alone is insufficient in *both* directions (`track = top` hides nested callers): **32 of 37** functions reporting zero DB callers are live product RPCs called from Next.js."*

  🚨 **THE SIX-SOURCE RULE IS COMPLETE FOR DB FUNCTIONS AND SILENTLY INCOMPLETE FOR EDGE FUNCTIONS — a SEVENTH source, `cron-job.org`, is invisible to every one of them (measured 2026-08-22).** Establishing it did not need an inference: `ufc-stub-thumbnail-resolver` has **ZERO in-repo callers**, **no `cron.job` row**, and no `pg_proc`/view/trigger reference — and `pipeline_runs` shows it executing **every 30 minutes, 1,143 times all-time**. **An external scheduler holds the only reference, and nothing readable from the repo or the catalogue records that it exists.** ⚠ **Consequence for any edge-function sweep: "nothing calls it" is not a conclusion the six sources can support.** Of the 24 functions in known-issues #23, six grep to zero callers and must still be treated as live. ⚠ **The second blind spot is `pipeline_runs` itself: 8 of those 24 never call `log_pipeline_run`**, so they report zero runs however often they execute — four of them sit on user-facing or cron paths (`/api/ufc-wallet-scan`, `/api/ufc-sales-indexer`, `/api/cron/ufc-enrichment-drain`, a GHA workflow). **Absence from that table is blindness, not dormancy.** 🚨 **AND THERE IS A THIRD BLIND SPOT THAT DEFEATS THE OBVIOUS WORKAROUND: `pipeline_runs.pipeline` IS NOT THE EDGE-FUNCTION SLUG.** A function self-reports under whatever string its own `p_pipeline` argument carries, and **4 of the 24 in known-issues #23 differ from their slug**: `backfill-topshot-subeditions` → `topshot-subedition-backfill`, `backfill-allday-listing-serials` → `allday-listing-serial-backfill`, `backfill-topshot-base-parallel-probe` → `topshot-base-parallel-probe`, `ingest-topshot-atlas-pool` → `topshot-atlas-pool-ingest`. ⚠ **A slug-keyed query returns zero rows and NO error — byte-identical to dormancy.** Measured 2026-08-22: keying on slugs put `backfill-allday-listing-serials` in a "never ran" list when it has **186 runs and had run that same day**, and `backfill-topshot-subeditions` alongside it when it ran the day before. **The mapping exists only in the function source, so it is invisible to every query** — read `p_pipeline` (or the `PIPELINE` const) out of `index.ts` before keying `pipeline_runs` on anything, and treat a zero-row result as unmeasured until you have. ✅ **What the table CAN support, with its own positive control:** `pipeline_runs_daily` is a **superset** of the live table (170 distinct pipelines vs 162) and retains indefinitely, so for a function that *does* self-report, never appearing there is real evidence of dormancy — 7 of the 24 qualify.
- ⚠ **Index hygiene: "unused" and "safe to drop" are DIFFERENT CLAIMS — require both a statistical and a structural ground.** `idx_wmc_wallet_collection` (72 MB) was dropped on 2026-08-14 because it had **0 scans** with `pg_stat_database.stats_reset` **NULL** and the postmaster up since 2026-06-12 (63 days, on a table whose other indexes show up to 48.7M scans) **AND** because it is a strict *prefix* of `idx_wmc_cohort_cover (wallet_address, collection_id) INCLUDE (fmv_usd)`, so anything it could serve, that one serves. ⚠ **Eleven more unused indexes >10 MB (~311 MB) were deliberately LEFT**: `idx_sales_*_nullseller_soldat` back the seller-recovery backfill that is **INERT pending `DUNE_SALES_SELLER_QUERY_ID`** (dropping them breaks that job the day it is switched on), and `idx_sales_2026_fmv_recalc_window` is *named* for a job that runs constantly, so its 0 scans mean the planner **rejects** it — a different question from whether it is wanted. Check each one's caller. Worth doing at all because `wallet_moments_cache` carries 14 indexes over ~1.6 GB and is the most write-heavy table on the platform. Revert is exact: recreate the index `CONCURRENTLY` via a one-statement pg_cron job (NOT `execute_sql` — see General rules).
- ⚠ **`refresh_wmc_fmv_changed` is the #2 disk reader (112 GB, mean 330 s) and is NOT a defect** — do not spend a session "fixing" it. Its `DISTINCT ON` temp build reads **2,568 buffers in 90 ms** over a 24-hour window; the genuinely redundant FMV re-lookup inside it prices at **0.24%**. The cost is the **UPDATE fan-out** — propagating one edition's FMV touches every row of every wallet holding it. **112 GB is the price of the `wmc.fmv_usd` denormalization**, and the lever is the denormalization. Details + the measurement plan (and the cutoff feedback loop to watch): [inbox 2026-08-15T0350Z](../../docs/overnight/inbox/2026-08-15T0350Z-refresh-wmc-fmv-changed-is-the-price-of-the-wmc-denormalization.md).
- Always query `information_schema.columns` before writing route handlers to confirm exact column names.
- RLS check: `SELECT array_agg(tablename) FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false`. Currently 0 rows — RLS on every public table (**367 public tables + 136 views** re-verified live 2026-08-16 ~23:57Z — views 134 on 08-13 → 135 → **136**, the newest being `v_rpc_trust_health_freshness`; the invariant is "0 rows", not the count — see [schema-truth.md](../../docs/reference/schema-truth.md)). ⚠ **The view count moves whenever anyone applies a migration, so treat it as a dated sample and re-query it; the tables figure has been the stable one.** ⚠ **That view figure EXCLUDES materialized views, which are a separate ~30** — `pg_views` and `information_schema.views` agree with each other and neither counts a matview, so a `pg_class` sweep over relkind `v` **and** `m` legitimately returns ~166 and is not a discrepancy. RLS-on is not the whole posture: also check `check_public_security_invariants()` and `check_anon_write_surface()` (both **0 rows**, re-verified 2026-08-16), since the default anon grant survives `REVOKE … FROM PUBLIC`.
- `health_check()` RPC function is the single source of truth for platform state.
- `pipeline_runs` uses `pipeline` text column (not `function_name`) and `ok` boolean (not `status` text); `extra` is JSONB — use `extra->>'key'` for text extraction.
- ⚠ **A WRONG ARGUMENT NAME ON `log_pipeline_run` MAKES A PIPELINE VANISH FROM TELEMETRY, SILENTLY (2026-08-15).** Every one of the ~128 call sites wraps the RPC in a deliberately **non-fatal** try/catch — telemetry must never break the work it measures — and PostgREST resolves an overload by its argument-NAME **set**. So one invented parameter means the call matches no overload, throws, is swallowed, and the pipeline simply never appears in `pipeline_runs`: **indistinguishable from "it was never invoked."** `/api/cron/stale-fmv-monitor` passed `p_duration_ms` and had therefore written **zero rows, ever**, while running on schedule via `ops-monitor.yml` — a monitor that could not be checked for having run. The live 11-arg signature is `p_pipeline, p_started_at, p_rows_found, p_rows_written, p_rows_skipped, p_ok, p_error, p_collection_slug, p_cursor_before, p_cursor_after, p_extra` (plus a 3-arg `(text, boolean, jsonb)` convenience overload). ⚠ **`p_duration_ms` can never be right** — `duration_ms` is a GENERATED column; pass `p_started_at` and it computes itself. Pinned by `__tests__/log-pipeline-run-args-match-the-function.test.ts`. ⚠ **Its parser reads DEPTH-1 keys only, and that is load-bearing**: `p_extra` nests arbitrary snake_case keys, and counting those reported **9 broken pipelines that were logging normally** — the live row counts contradicted it, which is how the bad parser was caught. *When a guard and a measurement disagree, believe the measurement.*
- ⚠ **A route whose work runs inside `after()` needs an INVOCATION HEARTBEAT, or a killed tick is indistinguishable from a cron that never fired.** `candy-offers-indexer`, `fmv-recalc`, `candy-listings-indexer` (2026-08-15) and `candy-editions-ingest` (2026-08-16) all write one — **that is all four `after()`-based ingest routes, so the set is CLOSED as of 2026-08-16; a new `after()` route joins it or the class reopens.** The truth table is the point: *heartbeat + terminal row* = ran to completion · *heartbeat only* = the run did not reach its terminal log · *neither* = route never reached (cron/auth). ⚠ **Always under a SEPARATE `<pipeline>-heartbeat` name** — a marker written under the pipeline's own name refreshes `last_run` every tick and silences `detect_stalled_pipelines()` on exactly the outage it exists to expose. (None of the four heartbeat names is on `pipeline_cadence_watchlist`, verified 2026-08-16 — the watchlist is explicit per-pipeline with no pattern matching, so adding a heartbeat creates no new arm.)
  ⚠ **"HEARTBEAT ONLY" IS THREE STATES, NOT ONE, AND THIS BULLET SAID "`after()` dropped or killed" UNTIL 2026-08-16 — WHICH IS THE MOST LIKELY WAY TO MISREAD ONE.** Every one of these routes wraps its `log_pipeline_run` call in a **deliberately non-fatal try/catch** (telemetry must never break the work it measures), so a missing terminal row means the run did not reach *or did not complete* its own logging — which is satisfied by (a) killed mid-`after()`, (b) killed during any post-walk step, **and (c) the work finishing normally and the logging RPC itself failing, swallowed by that catch.** ⚠ **(c) is the case where the pipeline is HEALTHY and only the telemetry is lost — the opposite operational conclusion to a kill**, and it is a plausible casualty of the same DB saturation that produces the kills, so it is not a remote possibility. **Do not report "heartbeat only" as a maxDuration kill without separate evidence.**
  ✅ **AND HERE IS THE CHEAP EVIDENCE, because (c) is testable in one query: ask whether OTHER processes' `log_pipeline_run` calls succeeded in the same window.** They all write the same row to the same table through the same pooler, so a saturation outage of the telemetry path is visible platform-wide, not per-route. Run on the 2026-08-16 `candy-editions-ingest` case it was decisive: writes landed at 08:53:20 (-46 s), **08:54:08.86 (+3 s from the route's own final data write)**, :14, :18 ×2, :37, :43 — i.e. the telemetry path was healthy in the very second that route's `logRun` should have fired, which **removes the mechanism that makes (c) plausible and leaves a kill as the best-supported reading**. ⚠ It weakens (c) rather than eliminating it — an isolated failure on one pooled connection is untouched by this evidence — so say "weakened", not "ruled out". **This is the first thing to run on any heartbeat-only tick; it costs one query and it decides which half of the problem you have.**
  ⚠ **The evidence that separates them is the LAST write of the run, not the first — and getting this wrong cost a wrong published diagnosis on 2026-08-16.** `candy-editions-ingest` was reported "silent 39.5 h", then diagnosed as killed at the wall off `editions.updated_at` being fresh. The walk's actual final write (`wallet_moments_cache`) landed **130 ms later**, proving the walk *completed* and moving the failure to at-or-after `logRun`. **Read the write that the route performs LAST** (check the source order — here `candy_packs` → `editions` → `wmc`, all inside the page loop), and note that a route with a post-walk step has a whole phase after its last data write in which it can die silently. Narrowing (a)/(b)/(c) needs a post-walk phase marker or a retry on the logging call; **neither is taken on any of the four.**
  ⚠ **Adding a heartbeat to a route RETARGETS every positional assertion in its tests.** The heartbeat is written before `after()`, so it becomes `st.runs[0]` on every accepted request, and the terminal row every existing test meant to inspect shifts down — silently, onto a row where `p_ok` is always `true` and `p_extra` carries none of the fields under test. Eleven assertions in `api-ingest-candy-editions.test.ts` had to move from `st.runs[0]` to a **by-name selector** (`st.runs.find(r => r.p_pipeline === …)`). **Select telemetry rows by pipeline name, never by index**, in any test for a route that logs more than one row.
- Supabase MCP multi-statement queries return only last result — use single statements per call.
- PostgREST caps reads at 1000 rows and CLAMPS explicit `.limit()` above that — paginate with `.range()` or use an RPC for larger reads. A **bare unbounded `.select()`** clamps at 1000 too (sneakier than `.limit(N>1000)`), and dedup-latest-per-edition **in JS over raw `fmv_snapshots` DESC** is a trap — the 1000-row window only covers a few hundred editions (~4,200 TS snaps/day), so use the `fmv_current` view (DISTINCT ON latest-per-edition) instead. **The count-vs-length trap:** requesting `{ count: "exact", head: false }` then reading `rows.length` for a total silently caps that "total" at 1000 — read the returned `count` (with `head: true`) instead. (Both fixed live 2026-07-19/20: lock-roi/market/sets-db truncations + market-pulse `snapshotsToday` 4× undercount.)
- ⚠ **AND ANY `.range()` PAGINATION MUST CARRY A DETERMINISTIC `.order()`, OR IT READS THE RIGHT NUMBER OF ROWS AND THE WRONG ROWS (2026-08-16).** Postgres guarantees no row order without `ORDER BY`, so offset-paging an unordered query returns some rows on two pages and some on none. `lib/supabase-paginate.ts` has stated this rule verbatim since it was written; `snapshot-institutional-wallets` **hand-rolled its own paging loop** instead of calling `fetchAllPaged` and broke it — for three months. ⚠ **The tell is a DISTINCT count, never a total**: `wallet_moments_cache` holds `UNIQUE(wallet_address, collection_id, moment_id)` so the source cannot contain duplicates (52,120 rows / 52,120 distinct), yet the snapshot it wrote held **52,123 entries / 45,059 distinct** — ~7,064 read twice, ~7,061 missed. **The duplicates and omissions CANCEL, so the count came out within 3 of the truth and every count-based check passed.** ⚠ **The pack-inventory wallet `0xb6f2481eba4df97b` is the cleaner demonstration and confirms `moment_count` is NOT inflated: wmc holds 11,800 / 11,800 distinct, and the snapshot wrote 11,800 entries / 8,960 distinct — the total matched EXACTLY while 24% of the membership was wrong.** Its 43,675 `direct_transfer` rows are therefore the same artifact class, which also dissolves the separate question of why none of them resolve to an edition: they are fabricated events, so the missing `edition_id` is a property of data that should not exist. Downstream, a day-over-day diff read each day's missing ~7k as departures and the next day's different ~7k as arrivals: **161,366 fabricated "buyback acquisitions", of which 41,301 of 41,307 distinct moments had been in the wallet since the first snapshot.** ⚠ **The same bug is harmless or catastrophic depending on the CONSUMER** — the identical defect on the identical table in `wallet-backfill-helpers.ts` cost only redundant idempotent re-upserts, because its Set decides what to SKIP: absence there means "do more work", not "an event happened". Guarded by `__tests__/paginated-range-requires-order-ratchet.test.ts`, now a **BAN at ZERO** — the population was driven 13 → 11 → **0** in the same session, so a new unordered `.range()` fails CI outright. ⚠ **AN EXPECTATION OF MINE WAS WRONG AND IS WORTH THE SPACE: I recorded that a single `.range(0, N)` used as a "first N" limit is a lower-priority member of this population, since it cannot duplicate or drop across pages. Triaged one by one, **ALL 11 remaining sites were genuine multi-page paging loops** (`while (true)` / `for (…; offset += PAGE)`) — the distinction is real in principle and described NONE of the code. Do not assume a flagged site is benign; open it.** ⚠ **Pick the order column from a UNIQUE key, not merely a selected one** — a non-unique order leaves ties between pages and reintroduces the defect. `moment_acquisitions.nft_id` looks like the natural key and is not (unique is `(nft_id, wallet, transaction_hash)`), so those sites order by the PK `id`. ⚠ **Adding `.order()` breaks every test stub that does not implement it** — six stubs across five files had to gain `order: () => b`; a chain method missing from a mock fails the whole query, not the ordering.
- **A batch `.insert()` is ALL-OR-NOTHING — never swallow `23505` on one.** A single duplicate row fails the whole statement and writes NONE of the batch, so `if (err.code === "23505") { /* dupes */ }` silently discards every co-batched **new** row. On a cursored indexer this is *permanent* loss: nothing lands ⇒ the cursor advances past those rows anyway ⇒ they are never retried. Always log only non-dupe errors (`code !== "23505"`) and fall through to a row-by-row retry, so real dupes fail individually while new rows land. **Also note supabase-js RETURNS errors rather than throwing** — a row-by-row fallback placed only in a `catch` block is unreachable for a 23505 (this was `sales-indexer`'s worse variant). Eradicated across all 5 forward sales indexers 2026-07-25 (candy, golazos, allday, ufc ×2 each on `sales`+`unmapped_sales`, plus topshot `sales-indexer`) and pinned by `__tests__/sales-batch-insert-23505-guard.test.ts` (directory-driven over `app/api/*sales-indexer/route.ts`, so new indexers are covered automatically). **NOT the same thing:** the `cron/*-sales-history-backfill` routes' `else if (code === "23505") { ...row-by-row... }` is CORRECT (the positive branch *is* the retry) — don't "fix" those; `pinnacle-sales-indexer` is safe via `.upsert(..., ignoreDuplicates: true)`.
- `players` + `sets`: composite `UNIQUE(external_id, collection_id)`.
- `execute_sql(query text) RETURNS void`, SECDEF, service_role only.
- `tier_type` enum (full live set): `ULTIMATE / LEGENDARY / RARE / UNCOMMON / FANDOM / COMMON / CHAMPION / CHALLENGER / CONTENDER`. Top Shot uses `COMMON / FANDOM / RARE / LEGENDARY / ULTIMATE`; UFC Strike uses `CHALLENGER / CONTENDER / FANDOM`. (`UNCOMMON` / `CHAMPION` exist in the enum too — see [schema-truth.md](../../docs/reference/schema-truth.md).)
- **Slug-keyed entity lookups need a FUNCTIONAL expression index, or they full-scan the collection.** Any RPC that resolves a URL slug via `regexp_replace(lower(trim(<name>)),'[^a-z0-9]+','-','g') = <slug>` (e.g. `get_team_detail`, `get_player_detail`) cannot use a plain btree — the slug is computed, so the planner scans every row in the collection applying the regexp as a filter. Cold, that page-read amplification (Knicks: 18,121 rows / 8,186 heap fetches / 6,703 buffers) balloons to seconds and HOLDS the pooled connection, surfacing as **"Timed out acquiring connection from connection pool"** on the entity page (Sentry NEXTJS-1Y team + NEXTJS-20 player). Fix is an expression index on the exact immutable expression: `players` has `idx_players_collection_name_slug`; `editions` has `idx_editions_collection_team_slug` (team_name, partial `WHERE team_name IS NOT NULL`, added 2026-07-26 — variant lookup 60→3.5ms, buffers 6,703→501). **A pool-acquire timeout is a SATURATION symptom, not proof of an inherently slow query — profile warm vs cold first** (these RPCs are 23–110ms warm); the lever is cutting the cold-scan that holds the connection, not rewriting the whole fn.

### Security posture (May 3 audit)

0 security ERRORs. SECDEF anon-revoke complete — 10 previously anon-callable fns now `postgres + service_role` only (incl. `query_sql`, `save_user_wallet`, `upsert_wallet_moments`, `pinnacle_upsert_nft_map`, `activate_pro_from_payment`, `classify_acquisition`). RLS on every public table (0 with `rowsecurity=false`). 17 SECDEF views dropped.

**`REVOKE … FROM PUBLIC` does NOT strip Supabase's default per-role `anon`/`authenticated` grant — and this applies to TABLES and VIEWS, not just SECDEF functions** (learned the hard way 2026-07-19: the entire "gated" Panini+Candy dataset — 17 objects incl. `panini_card_serials` with 1,011 collector usernames — was anon-readable via PostgREST because `proxy.ts` gates only the HTTP routes while the tables carried the default `anon` grant). Always `REVOKE SELECT … FROM anon` (and `authenticated` if pre-launch) **explicitly**, and verify with `has_table_privilege('anon', '<obj>'::regclass, 'SELECT')` or a functional `SET LOCAL ROLE anon` probe — **never** by reading `information_schema.role_table_grants`, which still listed `anon` after a successful revoke. **Route-gating ≠ data-gating:** anything staged behind a `proxy.ts` line is still queryable at `/rest/v1/<table>` unless the anon/authenticated grant is explicitly revoked. **MV-derived surfaces need the predicate IN THE VIEW, not RLS** — `refresh_sets_summary()` runs under pg_cron as a `rolbypassrls` role, so an RLS policy on the base table can't filter what lands in `sets_summary`; gate the view arm on `collections.is_active` instead. **FUNCTIONS are the MIRROR case (learned 2026-07-26 clearing the `secdef-anon-exec-drift` sentinel on two new `serial_fmv_estimate` overloads): a new function's default EXECUTE grant is to `PUBLIC` (`=X/postgres` in `proacl`), so `REVOKE EXECUTE … FROM anon, authenticated` removes the explicit rows but `has_function_privilege('anon', …)` STAYS true via the surviving PUBLIC grant — you must `REVOKE EXECUTE … FROM PUBLIC`.** ⚠ **AND THE CONVERSE IS EQUALLY TRUE — `FROM PUBLIC` ALONE IS NOT ENOUGH EITHER; REVOKE BOTH HALVES IN ONE STATEMENT (learned the hard way 2026-08-15, by doing exactly what the sentence above says and still shipping a drift).** This database also carries `ALTER DEFAULT PRIVILEGES` granting EXECUTE to `anon` + `authenticated` on new functions in `public`, so those arrive as **explicit acl rows a PUBLIC revoke does not touch**. A new SECDEF helper created with `REVOKE EXECUTE … FROM PUBLIC` measured `has_function_privilege('anon', …) = true` immediately after apply, and `check_secdef_anon_exec_drift()` went **0 → 1**. The correct form is `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC, anon, authenticated;`. ⚠ **And this is the case that proves the "verify with `has_function_privilege`, never the acl text" rule rather than merely restating it**: the PUBLIC row really was gone from `proacl`, so the acl text looked clean while the function was still anon-executable. **Re-run `check_secdef_anon_exec_drift()` after creating ANY function — a drift you introduce yourself looks exactly like one you inherited.** `postgres` (owner) + `service_role` carry explicit grants and survive a PUBLIC revoke, so internal SECDEF callers and `supabaseAdmin` RPC keep working; verify with `has_function_privilege('anon'/'service_role', '<sig>', 'EXECUTE')`, not the ACL text. For a SECDEF fn only reached by service_role clients (`supabaseAdmin`) or by other SECDEF fns (which run as their definer), **revoke** rather than allowlist in `secdef_anon_exec_allowlist` — the drift check (`check_secdef_anon_exec_drift()`) only flags fns that ARE anon/auth-executable, so removing the grant clears it and shrinks the anon surface.

⚠ **`check_secdef_anon_exec_drift()` IS STRUCTURALLY BLIND TO SECURITY *INVOKER* FUNCTIONS, AND THAT BLIND SPOT HID TWO UNAUTHENTICATED 40-SECOND QUERIES (measured + fixed 2026-08-16).** It considers `prosecdef = true` only, so every INVOKER function in `public` is outside it **by construction**, however often it runs green — the guard-scope class this file documents elsewhere, met on the security surface. **84 anon-executable INVOKER functions** existed; **8 were orphaned** (no caller in `pg_proc`, no view, no cron, no repo) and two were pathological to invoke:

| function | measured | callers |
|---|---|---|
| `compute_pack_ev_from_pool_tier_weighted` | **45,762 ms · ~2.29M buffers (~17.4 GB)** | none |
| `get_wallet_cache_count` | **39,450 ms** (only ~7.2k buffers — **IO STARVATION, not a bad plan**) | none |

Both confirmed reachable by a functional `SET LOCAL ROLE anon` probe, not inferred: the anon key ships in the browser bundle and PostgREST exposes every public function at `/rest/v1/rpc/<name>`. ⚠ **Severity is AVAILABILITY, not confidentiality** — INVOKER means the caller's own RLS applies, so nothing leaks that an anon visitor cannot already read; what it offers is unauthenticated compute against the heaviest tables on a 2 GB IO-budgeted instance, where a handful of concurrent calls is an outage for free. All 8 revoked (`audit_20260816_revoke_anon_exec_on_zero_caller_pack_fns`, `audit_20260816_revoke_anon_exec_on_six_orphaned_wallet_fns`); population **84 → 78**.

⚠ **A DB-SIDE CALLER SWEEP ALONE IS NOT EVIDENCE OF ORPHANHOOD AND WOULD HAVE BEEN CATASTROPHIC HERE.** Of the 37 anon-executable invoker functions touching heavy tables, **32 report ZERO DB callers** — including `get_wallet_moments_with_fmv`, `get_top_sales` and `get_market_pulse`, which are **live product RPCs** called from Next.js routes Postgres cannot see. Revoking on DB evidence would have taken down the wallet and analytics surfaces. **Require FOUR sources before calling one orphaned**: `pg_proc.prosrc`, `pg_views.definition`, `cron.job.command`, and a full-repo grep. ⚠ The **views** arm is load-bearing, not ceremony — a `security_invoker=true` view executes its callee AS THE CALLER, which is exactly why `serial_fmv_estimate` must stay anon-executable. ⚠ And match on word boundaries: `get_pack_detail` reads as called when every hit is the different, live `get_pack_detail_bundle`.

⚠ **NEVER AGGREGATE A PRIVILEGE CHECK OVER AN OVERLOADED FUNCTION.** A post-apply verification using `bool_and(has_function_privilege('anon', …))` for `serial_fmv_estimate` returned **false** and read as "a load-bearing public path just broke". Nothing had. There are **FOUR overloads**: two anon-executable (the 6- and 7-arg forms, reached by `get_wallet_moments_with_fmv` and `topshot_underpriced_serials_board`) and two deliberately revoked in the 2026-07-26 drift clearing. `bool_and` collapses a **per-signature** fact into one boolean. **Read it per `oid::regprocedure`.**

**The population is now frozen repo-side by `__tests__/migration-new-function-states-its-anon-exec-decision.test.ts`**: a new migration creating a `public` function must either revoke (naming **PUBLIC, anon, authenticated** — a PUBLIC-only revoke is explicitly rejected, per the paragraph above) or carry an `-- anon-exec: …` marker naming the function. Silence is not a decision. ⚠ Its cutoff is **forward-looking (`20260817000000`) so the in-scope population is currently ZERO** — setting it at "today" was measured and rejected because it would immediately red ~10 concurrent sessions' migrations — so it asserts **the walk and the detector** against synthetic fixtures rather than a non-empty population. ⚠ **A SNAPSHOT migration must use the MARKER, never a revoke**: unlike views and reloptions, `CREATE OR REPLACE FUNCTION` does **not** reset a function's ACL, so a revoke there changes production while pretending to be a byte-identical no-op. **The remaining 78 are deliberately NOT swept** — most are legitimately anon-reachable — ranking method filed at [inbox 2026-08-16T1910Z](../../docs/overnight/inbox/2026-08-16T1910Z-86-anon-executable-invoker-fns-are-invisible-to-the-secdef-drift-check.md).

⚠ **`CREATE OR REPLACE VIEW` WITH NO `WITH` CLAUSE SILENTLY STRIPS `security_invoker=on` — it RESETS reloptions, and this has now happened FOUR times (fixed + guarded 2026-08-15, `9da83e21`).** Verified empirically on the live instance rather than inferred:

```sql
create view pg_temp.zz with (security_invoker=on) as select 1;  -- security_invoker=on
create or replace view pg_temp.zz as select 1;                  -- options GONE
```

**A view's security mode does not appear in its OUTPUT**, so every correctness check passes identically either way: migration `20260815153324` recreated `topshot_deals_vs_fmv` + `cross_collection_deals_board` for a genuine perf win and verified output md5, row count, buffers and `Subplans Removed` — while both dropped to definer mode. `check_public_security_invariants()` caught it, but only on the next monitor sweep ~3 h later, and **nothing failed CI at all**. Four rules came out of it:
- **`ALTER VIEW … SET (security_invoker = on)` is the repair, never `CREATE OR REPLACE`** — an ALTER cannot drift the query definition while fixing the option.
- ⚠ **AND `CREATE OR REPLACE VIEW` CANNOT RENAME OR REORDER COLUMNS AT ALL — it errors `42P16`, and the SQL test CANNOT catch it (2026-08-16).** Rebuilding `v_pack_pipeline_health` changed the column list, so the apply failed outright: *"cannot change name of view column `pipeline` to `collection_slug`"*. ⚠ **`supabase/tests/*.sql` builds each object in a ROLLED-BACK transaction where no prior definition exists**, so the compatibility constraint against the LIVE view is invisible to it by construction — the test was green while the apply errored. **A green rolled-back DB test is not evidence that a migration APPLIES**; that is only learned from the apply. Use `DROP VIEW IF EXISTS` + `CREATE VIEW` (verify zero `pg_depend`/`pg_rewrite` dependents and zero repo consumers first, and restate `WITH (security_invoker = on)` — it does not survive the drop). ⚠ **The REVERT BODY needs the same DROP**: reverting renames the columns back and hits the identical 42P16, so a `CREATE OR REPLACE` revert fails **exactly when it is needed**.
- **Invoker is the fix, NOT an allowlist entry.** The invariant's own arm-(b) comment says it exists to catch "a hardened (invoker) view silently reverting to definer", so allowlisting would accept the exact regression it was built to detect.
- ⚠ **Do not inherit a "benign" verdict by ANALOGY.** The monitor called this benign by comparison to the Candy views — but those have anon SELECT revoked and so are not the same case. Here nothing leaked, but only because every base table is catalog/market data with no user-scoped rows, i.e. there was no per-user RLS to bypass. That is a fact you check, not one you assume from a neighbouring incident.
- ⚠ **A clean invariant does not prove the view still WORKS.** A broken invoker view regresses by returning nothing, so the repair was confirmed by re-fetching the public board anonymously end-to-end (same 50/50 rows, all three collection legs) — see the cache caveat under DB "General rules" for how that check itself first fooled me.

Guarded repo-side by `__tests__/migration-view-security-invoker-guard.test.ts`: every NEW migration creating a `public` view must either carry `security_invoker` in its own `WITH`, re-assert it with a matching `ALTER VIEW`, or carry the explicit `definer-view: intentional` opt-out — **silence is not a decision**. ⚠ It is keyed **per VIEW NAME, not per file**, because `20260801012254` creates two views and hardens only one though its header says it meant to do both — a file hardening view A must not vouch for view B. It **strips SQL comments first** (the offending migration quotes its own `CREATE OR REPLACE VIEW` in its header). The pre-existing `GRANDFATHERED` set is deliberately not re-litigated — an applied migration is history and editing it cannot change production — but **it must stop growing**.

⚠ **`proxy.ts` SENDS AN ENUMERATED `img-src` CSP, SO AN IMAGE ON AN UNLISTED HOST DOES NOT RENDER — AND IT FAILS LOOKING EXACTLY LIKE A DEAD LINK (found 2026-08-16).** The directive names our catalogue CDNs (`assets.nbatopshot.com`, `media.nflallday.com`, `ipfs.io`, …) plus `'self' data: blob:`. **Anything else is refused by the browser before a byte moves**, so a perfectly valid image URL renders as the element's fallback and nothing on any surface says why. This bit on collector AVATARS: `https://i2c.seadn.io/…` could never have displayed. ⚠ **There are TWO CSP headers** — a permissive `img-src 'self' data: blob: https:` from `next.config.ts` and this restrictive one — and **browsers enforce multiple CSP headers as an INTERSECTION**, so the restrictive one governs; do not read the permissive one and conclude any host works. **The fix for a third-party image is to serve it from our own origin** (`'self'` is in every policy we send), which is what `app/api/public/avatar-media` does, rather than widening `img-src` host by host forever. ⚠ **Its host allowlist IS its SSRF guard** — the same shape as `/api/public/ipfs-media/[cid]`, whose header says the CID regex is the guard *because the upstream host is fixed*; an avatar has no fixed host, so the bound has to come from an allowlist. **An any-host proxy was rejected on merit**: DNS rebinding means a name can resolve public when you validate it and private when `fetch` re-resolves it, and closing that needs IP-pinned connections `fetch` does not expose. ⚠ **NEVER re-serve `image/svg+xml` from our origin** — an SVG is a document that can carry `<script>`, so same-origin it runs with the session: **stored XSS delivered as a profile picture.** That is why the content-type check is an ALLOWLIST and not `startsWith("image/")`, which admits it. ⚠ And match hostnames EXACTLY: a mutation swapping `includes()` for `endsWith()` **survived** the first test suite, because every bypass fixture ended in some *other* domain — **`evilarweave.net` is the case with teeth**, since it ends with an allowlisted host and anyone can register it.

**Auditing "who can actually call this?" — three traps, all hit on 2026-07-31 (client-executable SECDEF taken 61 → 4, client-executable WRITERS → 0).** (1) ⚠ **An identifier named `supabase` is USUALLY THE SERVICE-ROLE CLIENT in this repo.** `lib/supabase.ts` exports both (`supabase` = anon, `supabaseAdmin` = service role), but **9+ files import `supabaseAdmin as supabase`**, and several API routes build their own `createClient(url, SUPABASE_SERVICE_ROLE_KEY)` and name it `supabase`. So `supabase.rpc(...)` proves nothing about the effective role, and **"server-side" ≠ "service role"** — resolve the *binding*, never the name. Resolving all of them showed the entire browser/anon + session RPC surface is **two functions**, and `components/**` makes **zero** direct `.rpc()` calls (the browser reaches data through `/api/*` routes). (2) **A direct-caller sweep is NOT sufficient to justify a revoke — check INVOKER-mode callers too.** A `SECURITY INVOKER` function or a `security_invoker=true` **view** executes its callee **as the caller**, so an anon-reachable invoker keeps an anon EXECUTE grant load-bearing even when every *code* caller is service-role. This is why `serial_fmv_estimate` must stay anon-executable (reached via `get_wallet_moments_with_fmv` and the view `topshot_underpriced_serials_board`); revoking on direct-caller evidence alone would have broken the wallet-moments read and a public board. Sweep dynamic `.rpc(var)` sites and direct `/rest/v1/rpc/` fetches as well as literal `.rpc("name")`. (3) **A green drift check says "unchanged since the baseline", NOT "safe"** — the 07-20 baseline accepted 49 rows under one bulk note and an unauthorized writer rode along inside it. `secdef_anon_exec_allowlist` now enforces `secdef_allowlist_note_is_a_real_reason` (note ≥ 40 chars, no `baseline%`), so each acceptance must state which client reaches the fn and why that is safe.

---



---

## Preserved from the 2026-08-17 CLAUDE.md restructure

> These lines were condensed or dropped in CLAUDE.md when it was cut to fit the memory-file
> char limit. They are kept here verbatim so nothing is lost.

## Supabase schema facts (critical — verify before writing queries)

**Volatile facts (table existence, FMV home per collection, enum values, RLS-on count) are generated from the live DB into [docs/reference/schema-truth.md](../../docs/reference/schema-truth.md) — that file wins on any disagreement with the prose below.** It is regenerated by the weekly `rpc-data-quality-sweep` (drift → ledger Queued). The conventions below (the two collection vocabularies, partitioning, UUIDs) are stable; the per-table/enum/count specifics can drift, so confirm against schema-truth.md (or re-query) before relying on them.

## Re-pinning a stale DB-invariant pin — the recipe, and what six of them taught (2026-08-22)

All six pins in known-issues #24 were closed this day. **No DB or prod state was changed by any of them:** a
snapshot migration is a byte-identical capture of what prod already runs, and applying it buys nothing while
costing a ~10–20 s user-facing `PGRST002` burst. **Leave them unapplied** — `migration-parity` checks
applied→file, so an unapplied file is invisible to it.

**The recipe:**
1. `pg_get_functiondef()` the live definition. ⚠ **Verify the transcription against the DB's own
   `md5(pg_get_functiondef(...))`, never by eye.**
2. Diff it against the pinned copy (embedded between the `>>> BEGIN verbatim` markers in
   `supabase/tests/<fn>.sql`) — the checker compares `prosrc` under two normalizations (whitespace-collapsed,
   and comment-stripped), so a STALE verdict is real logic drift, not formatting.
3. Replace the test's verbatim block, write the snapshot migration, repoint the PINS entry in
   `__tests__/db-invariants-drift-guard.test.ts`.
4. **The assertion review IS the work** — the checker's own remedy says *"a stale pin usually means the
   assertions describe old behaviour."* 🚨 **Repointing without it converts a loud, correct alarm into a
   silent green**, which is strictly worse than the red.
5. Verify: the body must hash **identically across live `prosrc`, the test and the migration**; then run the
   pin's SQL test and all 178 DB-invariant files locally (recipe in [testing-and-ci.md](testing-and-ci.md)).

⚠ **A snapshot migration must state its anon-execute decision with the MARKER, never a REVOKE** — the guard
enforces this and it caught the first attempt. `CREATE OR REPLACE FUNCTION` does **not** reset a function's
ACL, so a REVOKE there would CHANGE production while presenting itself as a no-op. Confirm the real state
with `has_function_privilege`, not the acl text (all six: anon false, authenticated false, service_role true).

🔑 **The finding that held for all six: NOT ONE was what the register implied.** "6 stale pins" reads as
uniform rot. They were — a misleading header over a one-feature drift (`get_set_detail`, D20
`underlying_set_count`); a **correct** pin the checker could not parse because it is a PROCEDURE
(`reconcile_all_saved_wallet_stats`, no content change needed at all); a deliberate feature addition
(`public_board_liveness_sweep` — rotation + predictive skip); a sargability rewrite that looked like a live
pricing defect (`get_active_challenges`); its sibling whose body got shorter while gaining logic
(`get_challenge_plan`); and a partition-pruning predicate whose "no-op" rested on an unstated data
assumption (`get_pack_detail_bundle`). **A count of stale pins is a work-queue length, never a description of
the work** — and two of the six would have shipped wrong without a cheap positive control.

⚠ **The `lower(col) = lower(arg)` → `col IN (arg, lower(arg))` rewrite** (both challenge functions) is
sargable but **narrower**: a stored address whose case differs from BOTH the argument and its lowercase form
no longer matches, so slots read as UNOWNED and `costToComplete` reads as full price. **Measured harmless
2026-08-22** — 25,447 mixed-case rows across 384 wallets in `wallet_moments_cache`, none with a lowercase
duplicate; 436 wallets own a challenge slot edition all-time; **the two sets are DISJOINT**. 🚨 **The first
impact query returned "0 affected wallets" and was VACUOUS** — there are zero active challenges, so it could
not have returned anything else. The 436 is the positive control that makes the zero mean something. **One
query separated a finding from a scare.** Both pinned tests now assert the case semantics explicitly.

---

## Displaced from CLAUDE.md — measurement traps that cost a wrong conclusion (verbatim, 2026-08-22)

### Displaced from CLAUDE.md 2026-08-27 (verbatim) — the directional-claim bullet, to pay for the UTF-16 clause in its header

⚠ **A directional claim needs a distribution, not a snapshot** (`fmv-recalc`: 3 failed characterizations in 2 days off one-instant reads), and **compare against the series' own history before calling something a regression** — a "collapse" turned out to be its rate for three weeks. Read a current-day rollup row as PARTIAL. ⚠ **A delta between two STOCKS across an unknown interval is neither a rate nor a sign** — a burst read as a trend, retracted at the third reading; measure the FLOW (`created_at` on the same predicate). ⚠ Aggregating a `text` column (`max(cursor_after)`) is a lexicographic max — it reported `'9500' > '11500'` and made a **wedged** sweep look like an advancing one.

⭐ **Why it moved:** CLAUDE.md's own header requires a new durable rule to DISPLACE one, and the rule
being added there — that Python's `len()` counts code points, not UTF-16 units — belongs in the
header itself, beside the `wc -c` warning it extends. This bullet's home was always the trap series
above.


The bullet below was condensed to a one-line rule in CLAUDE.md on 2026-08-22 to make room for the
DEFEATED-purge correction and the built-bundle instrument gap. The rule stands; only the cases moved.

> - ⚠ **A byte-identical HTTP response is as much the signature of a CACHE HIT as of a correct change**
>   (`/api/public/insights/**` sets a public `s-maxage`; the tell was an `elapsed_ms` identical to the
>   millisecond — re-run with a cache-buster) — ⚠ **and its DB analogue: an A/B benchmark must be
>   WARM-vs-WARM** (a cold candidate against a warm incumbent read as *5.6× slower* and nearly killed a
>   correct rewrite; **buffers held while the ms moved 9×**). And **an unordered `LIMIT` is not a sample**
>   but physical order — it reported 0.1% against a true 22%. Use `abs(hashtext(k)) % N`.

### 🚨 A SIXTH way a measurement lies: A GUARD THAT READS THE WORKING TREE IS BLIND IN A FRESH CLONE (2026-08-27)

⛔ **Both instances below are mine, from one session, and both were reported as green.**

**(a) The untracked file a clean clone cannot see.** `inbox-index-lists-every-filing` walks
`docs/overnight/inbox/` **on disk**. I verified a patch by `git am`-ing it onto a **fresh clone of
`origin/main`** and running the guard there: **5/5 green.** On the working tree that matters it was
**2/5 RED** — an untracked `2026-08-27T1808Z-daytime-monitor.md`, present on disk, absent from
`INDEX.md`. **An untracked file does not clone**, so the clean-clone run was structurally incapable
of failing.

⭐ **The rule: a clean-clone run proves the COMMITTED state and is silent about the LOCAL state the
same guard fails on. Any guard that reads the filesystem rather than the git index must be run where
the files actually are.** ⚠ **And the aggravating detail: I had singled that guard out as "the one I
ran deliberately this time," because it was the guard my previous patch tripped. Naming a check as
the one you were careful about does not make the environment you ran it in the right one** — it just
makes a blind result carry more weight than it earned.

ⓘ Its two assertions are separate and the second is the easy half to miss: every filing must be
listed **and** the header count must match. A new filing needs both the entry and the count bump.

**(b) `len()` is not `String.length` — code points vs UTF-16 units.** I reported CLAUDE.md at
**39,970**; the binding number is **39,974**. Neither reader is broken: Python's `len()` counts
**code points**, Node's `String.length` counts **UTF-16 code units**, and CLAUDE.md contains
**exactly four astral characters — four `🚨` (U+1F6A8), 2 units each.** ⭐ **So the delta was not
noise, it was the astral count, exactly.**

⛔ **The guard is a vitest test, so Node's number is the one that reds CI — and with 26 characters of
headroom, ONE `🚨` costs 2 of them, not 1.** A Python count of 39,996 can sit under the limit while
the guard is already over.

🚨 **And the file already said so.** `__tests__/claude-md-stays-under-the-memory-file-limit.test.ts`
carries the comment *"Node's `String.length` is the binding instrument"* — and records that `wc -c`
once read 40,086 on the same file. **I ran that test and measured with a different tool anyway.**
⭐ **Use the instrument the GUARD uses, not an equivalent-looking one; "characters" is three different
quantities (bytes, code points, UTF-16 units) and they diverge on exactly the emoji this repo's docs
are made of.**

### 🚨 A FIFTH way a measurement lies: A PARAMETERISED FUNCTION DOES NOT PLAN LIKE THE SAME TEXT INLINE (2026-08-27)

⛔ **This one was paid for in production.** `get_lock_check_batch`'s hot-wallet branch is a
`CROSS JOIN LATERAL` **per hot wallet**, each with its own `LIMIT p_limit` — the plan says it plainly:
**`Limit (actual rows=81 loops=574)`, i.e. 574 hot wallets and 46,320 rows read to return 200.**
Replacing it with a single scan filtered by `wallet_address IN (hot)` measured, **warm-vs-warm in one
session, with the slug and limit written as LITERALS**:

| form (inline CTE, literals) | buffers | time |
|---|---|---|
| lateral-per-wallet (current) | 49,438 | 56,421 ms |
| single scan (rewrite) | **232** | **15.3 ms** |

⭐ **And the baseline was independently corroborated** — the inline old-form 56,421 ms reproduced the
production mean of **51,041 ms over 694 calls**. Every methodological box was ticked: same session, warm
both sides, same predicate, real population, baseline cross-checked against production.

⛔ **Applied as the FUNCTION, it was WORSE:** **127,501 buffers / 73,486 ms**, then **127,534 buffers /
114,531 ms on a warm re-run** — ~2.6x the buffers of the form it replaced. Reverted ~4 minutes later
(revert proven exact by whitespace-collapsed md5 against the definition captured before the change).

⭐⭐ **THE RULE: measure the FUNCTION, by calling the FUNCTION.** With `p_collection_slug` and `p_limit`
as **parameters** the planner has no constants to prune with and can choose a completely different plan
from the same SQL text with literals substituted. **An inline CTE is a measurement of a query you are
not going to run.** ⚠ **The tell is not in the numbers — it is structural**: if the thing you are
optimising is a function whose *parameters appear in the predicates you are relying on for the win*,
the inline measurement cannot be trusted, however clean the A/B.

⚠ **Two corollaries worth keeping.** (1) **Run the suspicious result twice.** The first post-apply run
(73 s) dirtied 14,157 pages and was dismissible as a cold cache; **the warm re-run at 114 s is what made
it unambiguous.** (2) **What made trying it in production acceptable was that the function is
SELECT-only** — it picks candidates and writes nothing — so the worst case was a slower selection for one
tick. **Check that property BEFORE applying, not after**; here it also turned out that no tick ran during
the 4-minute window at all, which was luck rather than design. Ledger: 2026-08-27.

### 🚨 A FOURTH way a measurement lies: the PROJECTION can change the PLAN (2026-08-26)

⚠ **Isolating a sub-expression to price it is only valid if you isolate it with the REAL query's output
columns.** Measured while attributing the cost of `topshot_serial_board_candidates`:

| what was measured | plan | buffers |
|---|---|---:|
| the CTE alone, selecting only `edition_id` | **Index Only Scan** | **32,641** |
| the same CTE as the function runs it (also selects `fmv_usd`, `confidence`) | **Index Scan** | **818,698** |

**A 25× difference produced entirely by the projection**, because `edition_id` is covered by the
index and `confidence` is not — one uncovered column forces a heap fetch on every entry. The isolate
was then subtracted from the whole call, which produced the confident and exactly wrong conclusion that
the `serial_fmv_estimate` calls were ~96% of the cost when they are ~9%.

⭐ **The shape to recognise: a number, a control, and a subtraction, all measuring a plan the code never
runs.** The arithmetic is sound and the answer is inverted. **Price a sub-expression by REMOVING work from
the real query** (here: run the CTE + its join with the function calls deleted, which gave the true 90.7%),
never by re-writing it standalone. ⓘ This is the same family as the WARM-vs-WARM rule above — both are
cases of the A and the B not being the same query.

ⓘ Case, with the fix: ledger 2026-08-26 (the covering index), known-issues #30, and
[inbox 2026-08-26T1500Z](../overnight/inbox/2026-08-26T1500Z-the-targets-rpc-is-50s-of-DISTINCT-ON-and-edition-fmv-current-is-NOT-a-drop-in.md).

**Which `check_*` shape is which** (displaced from CLAUDE.md 2026-08-22, verbatim): a jsonb-array one
(`check_secdef_anon_exec_drift`, `…_execute_violations`, `check_edge_fn_http_failures`) returns
`count(*) = 1` when CLEAN — read the array LENGTH; a SETOF one (`check_public_security_invariants`,
`check_anon_write_surface`) returns **zero rows** when clean.

### ⚠ The "degraded band" is a CLOCK correlation, not a saturation guarantee (2026-08-23)

R6 has carried *"a degraded-band re-measure is still owed before closing"* since 08-22, naming the window
**16:20–18:05Z**. Measured **17:55–17:58Z, inside that window**, the database was **NOT saturated**:
`4 active · 1 IO waiter · longest active query 1.9 s`, against the audit's degraded reading of
*31 active / 30 IO waiters*.

🚨 **So an in-band reading does NOT discharge an owed saturation measurement, and any exit condition worded
"re-measure in-band" is under-specified.** "During the band" and "during saturation" are different asks and
only the second tests the claim. Re-word such an exit condition to name SATURATION — otherwise it gets
discharged by a quiet reading and a P1 closes on it. **Check `pg_stat_activity` (active / `wait_event_type='IO'`)
and state the reading alongside any timing taken "in-band".**

⚠ **A cold direct timing is not comparable to a warm production one, and mixing them fabricates a headline.**
The same day, a direct timing of AllDay's per-edition FMV lateral read **40,229 ms** — which cannot be its cost,
because the AllDay HTTP endpoint had returned **200 with real data two minutes earlier**. **A DB A/B must be
WARM-vs-WARM**; at ~74 ms per disk read a cold run measures the buffer cache, not the query. Discarded, and
recorded so nobody re-derives it and believes it.

---

## Compute-tier IO budgets — what the 22 MB/s floor actually is (2026-08-23, R46)

⚠ **CLAUDE.md's Infrastructure bullet points here.** It used to read *"fix expensive queries, don't upgrade (Medium is the same 2 cores for 4×)"*. **The policy is unchanged — don't upgrade — but two of its facts were wrong and are corrected below.** Trevor's call 2026-08-23: correct the facts, keep the policy.

**The 22 MB/s is a COMPUTE-TIER budget, not a disk property.** Settled two ways: the Management API reports `ci_small: { baseline_disk_io_mbs: 174, max_disk_io_mbs: 2085 }` — ⚠ **that field is MEGABITS and reads like megabytes**; 174/8 = 21.75 MB/s and 2085/8 = 260.6 MB/s, which reproduces the published table exactly. Taken at face value it overstates headroom **8×**. The published [Compute and Disk](https://supabase.com/docs/guides/platform/compute-and-disk) table is the independent second instrument and agrees.

| tier | baseline MB/s | burst MB/s | baseline IOPS | RAM | CPU | $/mo |
|---|---:|---:|---:|---:|---|---:|
| **Small (current)** | **22** | 261 | 1,000 | 2 GB | 2-core shared | $15 |
| Medium | 43 | 261 | 2,000 | 4 GB | 2-core shared | $60 |
| Large | **79** | **594** | 3,600 | 8 GB | **2-core DEDICATED** | $110 |
| XL | 149 | 594 | 6,000 | 16 GB | 4-core dedicated | $210 |

- ⛔ **No disk change lifts this instance.** *"The effective throughput is the lower of the throughput supported by the compute size and the provisioned throughput of the disk."* gp3's 125 MB/s default is capped by Small's 22. ⚠ **And provisioning extra IOPS/throughput at all "requires Large compute size or above"** — on Small the purchase is not offered. Two independent reasons; a gp2→gp3 migration was filed as a "$0 lever" and is **void**.
- ⚠ **"Same 2 cores" is true of Medium ONLY.** Large flips `cpu_dedicated` false→true. Small and Medium are burstable; the docs: *"Once burst capacity is exhausted, performance returns to baseline. If you need consistent disk performance, consider upgrading your compute size."* **Medium keeps Small's 261 MB/s ceiling and shared CPU — the same failure mechanism, later, not half a fix.**
- 💡 **Why this box looked correctly sized for months:** Supabase's guidance is `Max DB Size (Recommended)` = **50 GB** for Small, and this DB is **13.5 GB** — 27% of it. **The vendor's sizing metric is DATABASE SIZE, not WORKING SET.** The 6.5 GB hot set against 2 GB RAM is invisible to the number anyone would naturally check. ⚠ Generalisable: *"within the recommended size"* says nothing about whether the hot set is resident.
- ⓘ Vendor's own upgrade criterion, recorded as an input and not an argument: *"Projects that use any disk IO budget are good candidates for upgrading to a larger compute instance."* This instance does not dip into the budget — **exhausting it IS the 22 MB/s throttle.**

⛔ **DECIDED 2026-08-23 20:48 PT — Trevor: stay on Small. No spend, permanently, not "for now".** $96/mo (Large) declined = **$1,152/yr**. 🚨 **The operational consequence is the part to carry into other work: the IO budget is now at 100% BY CHOICE, so every new cron job, refresh, or index build spends headroom that does not exist — state its steady-state IO cost and what it displaces before proposing it.** ⛔ Do not re-suggest the upgrade except on a production build failing on a board read · first revenue or 50+ WAU · a public page serving degraded copy to anon visitors for a sustained window · the hot set passing ~8 GB. **E declined the SPEND, not the free work** — a zero-extra-IO piggyback is still on the table.

Full analysis, the numbered cost of declining, and the standing-rule collision: `docs/overnight/inbox/2026-08-23T1610Z-R46-…md`.

## ⛔ A lagging materialisation is unsafe as a FILTER for a predicate over the columns it lags on (2026-08-23)

Measured on `fmv_apply_thin_sale_haircut`'s Top Shot leg, in a genuinely quiet window
(`io_wait 8 / active 9 / total 47`). Full write-up:
`docs/overnight/inbox/2026-08-24T0455Z-the-fmv-haircut-topshot-leg-costs-800k-buffers-and-the-obvious-fix-loses-71pct-of-it.md`.

**The cost.** The read half alone, columns already narrowed to the eight the function uses:

```
Execution Time: 101,425 ms
Buffers: shared hit=780218 read=20327     (800,545 ≈ 6.25 GB)
Index Scan  fmv_snapshots_2026_collection_id_edition_id_computed_at_idx
  850,490 rows  →  Unique 19,667 editions  →  filter passes 14
```

**101 s and ~6.25 GB to locate 14 rows**, and the function runs that `DISTINCT ON` **twice** (measurement
CTE + `UPDATE ... FROM latest`), so the leg is ~200 s against a ~120 s cap. ⚠ **Column projection is NOT
the lever** — the unnarrowed `SELECT DISTINCT ON (edition_id) *` timed out at 110 s and the narrowed
eight-column version still took **101.4 s**. The cost is walking 850,490 index entries. This is R46
reproduced at function scope.

⚠ **The failure is the GATEWAY, not `statement_timeout`.** `1/7 legs failed: nba_top_shot: upstream
request timeout` is the Supabase gateway's ~120 s cap. The route's own comment block attributes it to the
global 120 s `statement_timeout` — the two bounds are within seconds of each other, which is exactly the
confusion this file warns about. It matters practically: on the gateway path **the statement is not
cancelled when the client gives up**, so a failed nightly run leaves ~100 s of scan still burning after
the failure has already been recorded.

**⛔ The obvious fix, and why it is wrong.** `edition_fmv_current` (13 MB, 27,075 rows, 5 collections)
materialises exactly the latest-per-edition this scan recomputes, and as a candidate source it is
**771× cheaper**: 1,038 buffers / 363 ms vs 800,545 / 101,425 ms. It also **loses 71% of the rows.**
Both shapes in ONE statement sharing ONE MVCC snapshot, diffing the SET rather than the count:

```
old_rows 14 · new_rows 4 · in_old_not_new 10 · in_new_not_old 0
```

**Mechanism:** `edition_fmv_current` stores its own copies of `fmv_usd`, `floor_price_usd` and
`confidence` as of the last refresh. The haircut predicate `abs(fmv_usd - floor_price_usd) < 0.01` is
evaluated at step 1 against those **stale** copies, so an edition whose TRUE latest snapshot qualifies is
dropped before step 2 can re-derive it. Safe as a display source; **unsafe as a filter for a predicate
over the columns it lags on.** Zero false positives is what makes it dangerous — both versions return a
small plausible number and no error.

⚠ **This nearly shipped on a moving target.** The first two readings were **1** row and then **4**, taken
13 minutes apart; the eligible population moved 1 → 14 within the hour because `/api/fmv-recalc` rewrites
it continuously. Comparing those two counts would have called the cheap shape "close enough". **Only the
same-snapshot set difference exposed it** — which is this file's own "diff the SET, not the count" rule
and its "a DB A/B must be warm-vs-warm" rule combining into a stronger one: **for a volatile population,
an A/B must share a snapshot, not merely a warm cache.**

## Caller enumeration — the SEVENTH and EIGHTH sources (2026-08-23)

CLAUDE.md requires **six** sources before believing a function has no caller (`pg_proc.prosrc`, `pg_views.definition`, `cron.job.command`, `pg_trigger`, a full-repo grep, and the Cowork artifacts' HTML), plus a **seventh** for edge functions: **cron-job.org**, invisible to all six *and* to `cron.job`.

🚨 **There is an EIGHTH, and it runs production ingests: Windows Task Scheduler on Trevor's box.**

| task | cadence | script |
|---|---|---|
| `RPC Deal Board Ingest` | every 3 h from 00:13 PT | `scripts/run-active-listings-ingest.ps1` |
| `RPC Pinnacle Render Cache Fill` | **every 15 min** | `scripts/pinnacle-render-cache-fill.mjs` |
| `RPC Panini Ingest` | every 4 h | — |
| `RPC AllDay Badge Ingest` | daily 05:37 PT | `scripts/run-allday-badge-ingest.ps1` |

Enumerate with `Get-ScheduledTask | Where-Object { $_.TaskName -match 'RPC' }`. ⚠ **Read the cadence from `$t.Triggers[0].Repetition.Interval`** — `StartBoundary` alone shows only the first fire and hides a `PT3H`/`PT15M` repetition entirely. Logs are under `%LOCALAPPDATA%\<task-name>\`; ⚠ they carry NUL bytes so `grep` calls them binary — pipe through `tr -d '\000'`.

💡 **This is where "residential Atlas ingest" physically happens** — a phrase carried in the notes for months with no location attached. Atlas WAF-blocks GitHub runners and Vercel egress but not Trevor's home IP, so for `topshot-active-listings-ingest` **the local task is the arm that works and the GitHub Actions workflow is the arm that never could**. A GHA-only reading of that pipeline measures the arm that was never going to succeed (known-issues #30).

### ⚠ A failure rate is a claim about a POPULATION — ask where the telemetry is written

Three instruments gave three rates for that one pipeline and **none was wrong about its own population**: ~60% `egress_blocked` (a 5-of-7 `pipeline_runs` sample), 80% (all of `pipeline_runs`), 22.5% (GitHub Actions run conclusions).

🚨 **`pipeline_runs` was blind to the dominant failure by construction:** the route writes `log_pipeline_run` in its **POST** phase and the failure killed the run in the **GET** phase, so the table held only runs that had already survived the thing that stops the pipeline. Inside that filtered population `egress_blocked` genuinely is ~80%. ⓘ The tell was arithmetic: two callers × 8/day should leave ~48 runs in the 73 h retention window; it held **7**.

➡ **Before quoting a pipeline's failure rate, ask (a) which callers exist and (b) at what point in the run the telemetry is written.** A rate from the pipeline's self-report and a rate from its scheduler are not comparable, and neither is "the pipeline's rate". **`max(last_seen_at)` on the OUTCOME table is the only instrument that sees every arm** — it is what refuted a "100% red for 5 days" claim in one query.

---

## Scoping an aggregate is an EQUIVALENCE claim — the `drain_fmv_cold_tail` fix, and the two ways it could have been mis-shipped (2026-08-25)

**The defect, and the cleanest instance of "a `LIMIT` bounds OUTPUT, not COST" this repo has.**
`drain_fmv_cold_tail`'s candidate query opened with

```sql
WITH latest AS (
  SELECT edition_id, MAX(computed_at) FROM fmv_snapshots GROUP BY edition_id   -- every row, every collection
)
```

and only then LEFT JOINed it to `editions` filtered to one collection. Draining a **518-edition** collection
therefore grouped **~1.28M** snapshot rows, and the `LIMIT p_limit` sat *above* the aggregate where it could
not help. Fixed by one `WHERE collection_id = v_collection_id` inside the CTE.

**Measured 2026-08-26 ~04:15Z, `ufc_strike`, `EXPLAIN (ANALYZE, BUFFERS)`, instance at io_wait 8 / active 11
(deliberately not in a saturation spell — a spell confounds every timing in BOTH directions):**

| | buffers | snapshot rows | time | result |
|---|---:|---:|---:|---|
| as-written (unscoped) | 66,499 | ~1,281,000 | 38,615 ms | 0 rows |
| scoped (shipped) | 741 | 4,391 | 173 ms | 0 rows |
| | **~90×** | ~292× | ~223× | **IDENTICAL** |

Both plans report *"Rows Removed by Filter: 518"* — same editions examined, same zero candidates. Served by
the **already-existing** `fmv_snapshots_2026_collection_id_edition_id_computed_at_idx` as an Index Only Scan,
so **no index was built** — which matters on an instance whose IO budget is at 100% by choice (R46).

### ⭐ The durable rule: PROVE the equivalence over the population, do not argue it from the plan

Scoping an aggregate changes the *answer* whenever the scoping column can disagree with the grouping key's
own row. Here: a snapshot's `collection_id` versus its edition's. **Measured across every row —
1,281,003 snapshots joined to editions, 0 with a differing `collection_id`, 0 NULL.**

⚠ **This is the step that made it shippable rather than merely plausible.** The A/B alone proves the new form
is *faster*; it proves nothing about whether it is the *same query*. Two plans returning the same rows on one
collection at one instant is a sample, not an equivalence. **Run the disagreement count before you ship a
scope, and record it — it is the only artifact a reverter can check.**

### ⚠ A `CREATE OR REPLACE FUNCTION` does NOT reset the function's ACL — so the migration carries a MARKER, not a REVOKE

`drain_fmv_cold_tail` is already anon/authenticated-revoked in prod. Re-issuing the body leaves that intact
(verified live before and after: `has_function_privilege` anon=false, authenticated=false, service_role=true).
**A defensive `REVOKE` in the migration would therefore have been the one statement in it that actually
changed production** — a scope widening disguised as caution. The migration records an `anon-exec:` decision
line instead. ⓘ Post-flight on any function change: `prosecdef`, `proconfig`, the three
`has_function_privilege` reads, `check_secdef_anon_exec_drift()` (**read its jsonb array's LENGTH, not
`count(*)`**) and `check_public_security_invariants()` (**0 rows when clean**).

### ⛔ The near-mis-claim: a scheduled tick is only a control if it ran on the NEW body

A `drain-fmv-cold-tail` tick at **04:17:14Z** wrote **89 rows, ok=true** against 6 and 13 on the two prior
ticks — and it was tempting to publish that as validation. **It was not: the migration applied as version
`20260826041837` = 04:18:37Z, so that tick ran on the OLD body.** ➡ **Compare the tick's timestamp against
the migration's VERSION STRING, which is a UTC stamp of the apply, not against your memory of when you ran
it.** The same rule as the production-caller control above: a manual invocation proves the function works,
never that the *scheduled* caller does.

⚠ **And "fast at doing nothing" is not a fix.** The first post-apply run (`ufc_strike`) returned
`processed: 0` — correct, and evidence of speed only. A **write control** was run separately
(`nfl_all_day`, limit 3 → `processed: 3, ask_only: 2, stale: 1`) and the rows confirmed **from outside the
function** in `fmv_snapshots` at the run's exact `computed_at`.

### 🚨 The cost was never "slow" — it was THREE COLLECTIONS SKIPPED, under `ok: true`

Measured only *after* shipping the fix, which is the wrong order and worth admitting: the route
`drain-fmv-cold-tail` sweeps **four** collections in one tick against a **45,000 ms budget**, calling the
function once per slug and recording `skipped` / `slugs_attempted` / `deadline_hit` in `extra`. The unscoped
aggregate cost ~38.6 s **per call**, so a tick that ran it cold burned the entire budget on the FIRST
collection and abandoned the other three.

**Baseline over the whole 73 h `pipeline_runs` window, everything strictly before the migration
(`started_at < 2026-08-26 04:18:37+00`): 134 ticks · 42 `deadline_hit` (31.3%) · 415 slugs attempted ·
121 slugs SKIPPED (22.6% of the 536 collection-slots).**

⚠ **Every one of those 134 ticks recorded `ok: true`.** The 04:17:14Z tick reads
`ok: true, rows_written: 89` — and its `extra` says `slugs_attempted: 1`,
`skipped: ["nfl_all_day","laliga_golazos","ufc_strike"]`. ➡ **Same family as the `rows_written = 0` null
instrument: a multi-arm pipeline's `ok` flag describes the ROUTE, not the arms.** For any budgeted
fan-out route, read `deadline_hit` and the length of `skipped`, and treat a rising `rows_written` on a tick
that attempted one arm as evidence of *starvation*, not throughput.

⚠ **It also explains an anomaly that looked like the fix working.** The 89-row tick stood out against 6 and
13 — but it is the *deadline-hit* signature (one collection given the whole budget), not the fix; the fix
applied 83 seconds later. **The number that moved was a symptom of the defect, not of its removal.**

### ⓘ Negative control: the defect did NOT spread — population is ONE

The standing rule after finding a defect is *grep for the EXPRESSION, not the file*, because this one has
spread by copy-paste five times. Swept `pg_proc.prosrc` for the same shape across the whole schema:

- **`FROM fmv_snapshots` + `GROUP BY edition_id` → 3 functions.** `detect_floor_drops` scopes both its
  snapshot CTEs with `WHERE collection_id = v_collection_id` (its `GROUP BY edition_id` is on `sales`, also
  scoped); `get_topshot_hot_floors` reads snapshots through a per-edition `LATERAL … ORDER BY computed_at
  DESC LIMIT 1`. **Both already correct.**
- **`FROM fmv_snapshots` at all → 76 functions**, of which only **3** never mention `collection_id`:
  `analytics_pipeline_health` (every read is `ORDER BY … DESC LIMIT 1` behind a window predicate, with a
  comment saying so), `analytics_fmv_pipeline_health` (bounded by `computed_at >= now() - 48h` and
  collection-agnostic **by design** — it reports per-collection health) and `analytics_fmv_top_movers`.

⚠ **The `mentions_collection_id` heuristic is COARSE and must not be quoted as a clean bill** —
`drain_fmv_cold_tail` itself mentioned `collection_id` twice while its aggregate ignored it. The predicate
that actually finds this defect is *"is the aggregate's own FROM clause scoped"*, which only a read of the
body answers. **3 bodies were read; 76 were not.**


## PG17 partial-index reachability — a DECIDABLE rule, and two null instruments found proving it

*Added 2026-08-25 (PT). Supersedes the "reachability is per-index and only an EXPLAIN settles it"
conclusion in `docs/overnight/inbox/2026-08-23T1910Z-…`, which was true but stopped one step short.*

### The rule

> A partial index whose predicate contains `<col> IS NOT NULL`, where `<col>` is declared
> `NOT NULL`, is reachable **iff the QUERY independently supplies something the planner can prove
> implies `<col> IS NOT NULL`** — a strict-operator clause on that column (`col = x`, `col <> x`,
> `col > x`), or an **inner join** on it. It is unreachable when the ONLY source of that qual was
> the query's own literal `col IS NOT NULL`, because PG17 constant-folds that away *before*
> predicate proving.

⭐ **Why the predicate SHAPE was never a usable selector:** the shape describes the INDEX, and
reachability is a property of the **query/index pair**. The rule above makes it decidable by
reading the query, without an EXPLAIN per index — though an EXPLAIN is still the confirmation.

**Proven both directions on a scratch table (PG 17.6), 2026-08-25:**

| index predicate | plan |
|---|---|
| `WHERE (price_usd > 0 AND edition_id IS NOT NULL)` | **Seq Scan even under `enable_seqscan = off`** |
| `WHERE (price_usd > 0)` | `Index Only Scan`, chosen with seqscan enabled |

The negative control is the strong one: the planner would rather do the thing it was explicitly
told not to do than use the index.

**All six `public` partial indexes of this shape, classified — 5 reachable, 1 not:**

| index | what supplies the proof | verdict |
|---|---|---|
| `pack_drop_pool_edition_idx` | `WHERE edition_id = $1` | reachable |
| `idx_sales_2026_top_sales_board` | `v_insights_top_sales` does `JOIN editions e ON e.id = s.edition_id` | reachable |
| `unmapped_sales_resolver_targets_idx` | its own sibling conjunct `nft_id <> ''` is strict | reachable |
| `unmapped_sales_sold_at_unresolved_idx` | same | reachable |
| `idx_pinnacle_editions_set_name` | `WHERE set_name = $1` | reachable |
| `idx_sales_2026_fmv_recalc_window` | **nothing** — `GROUP BY edition_id` is not a strict clause | **unreachable — REPAIRED 2026-08-25** |

### ⚠ Two null instruments, both of which read as an answer

1. **A cumulative `idx_scan` is a claim about the PAST.** But a **paired delta** does settle
   current reachability: over one 4-minute window `pack_drop_pool_edition_idx` moved
   420,894 → 420,898 while `idx_sales_2026_fmv_recalc_window` held flat at 3. Same instrument,
   same window, opposite answers. That is the cheap test — one index alone tells you nothing.
2. 🚨 **`n_live_tup` is an ESTIMATE, and on a never-analyzed relation it reads 0 — which is
   indistinguishable from empty.** `sales_2022` reported `n_live_tup = 0` and was proposed for
   index cleanup as "an empty partition"; `count(*)` returns **750,702** rows and its indexes carry
   **43,815,424** scans. It reads 0 because `n_tup_ins/upd/del = 0` and `last_autoanalyze IS NULL`,
   so the estimate was never set. **Any emptiness claim must come from `count(*)`** — or at minimum
   be corroborated by `pg_relation_size` (one index there is 78 MB, which no empty table produces).

### The repair, and its measured limit

`idx_sales_2026_fmv_recalc_window` rebuilt without the redundant conjunct via the one-off pg_cron
`CREATE INDEX CONCURRENTLY` recipe (202 s). On the **unmodified** production query the plan node
went **51,040.92 → 15,264.74** and `EXPLAIN (ANALYZE, BUFFERS)` read **18,124 ms** against the
**50,471 ms** on record — ~2.8x, reproducing the predicted 2.9x.

⚠ **The BUFFER half of the prediction did not reproduce: 84,667 measured against ~48,494
predicted, and `Heap Fetches: 82,082` is the entire gap.** An Index Only Scan falls back to the
heap wherever the visibility map is unset; `relallvisible/relpages` was **83.2%**, and a
`VACUUM (INDEX_CLEANUP OFF, ANALYZE)` took it to **88.6%**. ⭐ **Generalisable: when an
Index-Only-Scan win under-delivers on buffers, read `Heap Fetches` before doubting the index.**
