# Focus — 2026-08-17, steers appended through 2026-09-05 (accuracy-gate phase; the June studio-platform program is HISTORY)

⚠ **This file was 54 days stale until 2026-08-17** (it was still the 2026-06-24 studio-platform post-ship watch). That is not merely untidy: three of its steers had gone **actively wrong**, and a night pass following them would have been misdirected. The obsolete steers are listed at the bottom under "RETIRED STEERS" with the reason each died, so nobody re-adds them from an old copy. The June program's detail is **not lost** — it lives in `docs/overnight/ledger.md` and `docs/handoff-2026-06-24-studio-platform-gql-deep-history.md`.

**Rewrite rule for whoever edits this next: a focus file STEERS the next night, it is not an archive.** If a section is describing something that shipped more than ~a week ago and is not still a live trap, move it to the ledger and delete it here. A stale steer is worse than no steer.

## STEER — added 2026-10-25 ~8:45 PM PT (Claude Code cloud, session_011fh9vTVkSG2QPpsL5ihQbc, thread close) — expected readings from the ULTIMATE / Sniper / honesty-sweep evening

- **Expected, not anomalies:** (1) ~19 ULTIMATE editions now carry a NO_DATA `ultimate-v1` row (the writer retires its own price when the model finds nothing; `pipeline_runs.extra.retired_no_data` counts them); the four Kon Knueppel Signature Series /1s read no FMV. (2) `/nba-top-shot/sniper` shows FEWER #1 / perfect-serial deals: small editions' #1 now prices off `serial_fmv_estimate` (~3× base, not 8×), so many fall out; large editions' #1 prices HIGHER. (3) Sniper cards name series "25-26" / "S1", never a bare "8" / "0". (4) Top Shot moment pages now show a "Listed" ask when `ts_listings` holds one — before tonight every Top Shot moment read "Listed —" (`cached_listings_v2` holds no Top Shot rows). (5) Analytics panels read "Loading…" / "Couldn't load" instead of an empty chart; edition "24h change" reads 0.0% when the last move is older than yesterday. (6) Rookie Board set headers read "Series 2025-26", not "Series 8"; Pack Sniper's ratio tiles read "—" on an empty book; Pack Reality's first two buckets read "$0 exactly" / "$0.01–$10".
- **Not a regression — known limit:** a Top Shot moment with no `ts_listings` row still reads "Listed —". `ts_listings` is the 24 h Atlas window, not the whole book, so the dash means "not seen", never "not listed". Don't "fix" it by reading absence as a fact.
- **A regression would look like:** a Sniper #1 card whose Adj. FMV is exactly 8 × base FMV with a HIGH/MEDIUM base and a `serialFmvEstimate` present (the re-price was bypassed); a moment page quoting a `ts_listings` ask older than that NFT's latest sale (the ghost check was dropped).
- **Re-read due ~10-30:** #213 (All Day team-label rows).

## STEER — added 2026-10-25 ~6:20 PM PT (Claude Code cloud, session_011fh9vTVkSG2QPpsL5ihQbc) — expected readings from the evening #211 / person-key / sweep thread

- **Expected, not anomalies:** All Day team pages and series cards lose their "… II" / "Jr." label rows — one row per person, named by `players.name` (Chiefs: one Patrick Mahomes row, 32 editions); team "Players" headers drop by the number of merged labels. Team Recent-Low Totals and team cheapest entry drop where an ask > 3× FMV was summed. `check_function_search_path_drift()` = `[]` while the Supabase advisor still lists `recent_low_usd` under `function_search_path_mutable` — that is the deliberate exemption (20261026001535), ⛔ do NOT ALTER it (13× slower). `/teams/nba/portland-trail-blazers`-style URLs 308 to the short hub slug.
- ✅ **#211 CLOSED 2026-10-25 ~6:35 PM PT** (Cowork cloud): part B2 (`20261026013559`) ran through the dashboard SQL editor with Trevor present; rollup refreshed; series Recent-Low Totals ignore an out-of-band floor. Nothing left on this thread.
- **A regression would look like:** a roster row with `id` NULL for a label whose editions carry a `player_id` (someone re-grouped by label), or `check_function_search_path_drift()` listing `recent_low_usd` (its comment was dropped — a `CREATE OR REPLACE` keeps comments, a DROP/CREATE does not).

## STEER — added 2026-10-25 ~4:22 PM PT (Claude Code cloud, session_01JDr9dRaYirH2cYvS9KQw94, thread close) — production HTML sweeps: expected readings + ONE open item

- **What changed (ledger 10-25 ~1:46 → ~3:30 PM PT):**
  - The skip-link anchor renders (a server component had read a constant from a `"use client"` module; new guard `server-never-reads-a-value-from-a-client-module`).
  - Edition AND moment Activity tables tag BUYBACK purchases (`get_edition_recent_sales` `20261025211314`, `get_moment_detail` `20261025215633`; shared copy `lib/entity/buyback-copy.ts`).
  - Squeeze "none held" for system-held editions; Pack Reality names all three high-variance triggers; Top Sales copy names every collection.
  - Set + player Recent-Low Totals and entity tiles ignore a "recent low" above 3x FMV (`recent_low_usd`, `20261025221903`).
  - R61 closed: GHA crons stay as asked, commented.
- **Expected, not anomalies:**
  - A BUYBACK tag on ~2k Top Shot sales a month (785 editions in 30 d) beside counts that exclude them.
  - A tile showing "—" where it used to show a "Recent Low" far above FMV.
  - Set/player Recent-Low Totals dropping where a carried-forward ask was summed (2025 Rookie Ultimates $79,070 → $23,770).
  - Squeeze "none held" on ~35 editions.
- ✅ **~5:00 PM PT 10-25: parts C and B1 (series LIVE path) are APPLIED** (`20261025235754`, `20261025235853`); team pages and `get_team_sets` cheapest entry now ignore an out-of-band floor. **Only B2 (`refresh_series_detail_rollup`) is left** — its prompt went unanswered a third time; needs Trevor present. Series pages read the rollup, so they still sum the raw floor until then. The bullet below is the earlier state.
- **⚠ (superseded above) known-issues #211, do this first if you can apply migrations:** parts B (series totals + the rollup refresh) and C (team totals + cheapest entry) are staged in `docs/audits/staged-2026-10-25-recent-low-parts-b-c/` with landing steps. Part B's apply stopped twice on an MCP confirmation prompt nobody answered (likely the `DELETE` in the rollup body). Try C first; apply B with Trevor present. Until then, series and team pages still sum the raw floor. If they disagree with the set/player pages for the same editions, it is this, not a regression.
- **A regression would look like:** a BUYBACK tag on a row whose buyer is NOT in `buyback_wallets`, or none on one that is (the RPC predicate is the `sales_market` one, collection-scoped). Or `[function(){throw Error(...)}]` back in any page's inline `<style>`: someone re-imported a constant from a client module, and the guard reds on that.

## STEER — added 2026-10-25 ~12:50 PM PT (Claude Code cloud, session_01JDr9dRaYirH2cYvS9KQw94, thread close) — expected readings from the 10-25 latency / alert / concierge-budget thread

- **What changed (ledger 10-25 ~9:40 AM → 12:50 PM PT, 9 entries):** 4xx-arm idle≠blocked (`20261025164733`); pack page EV row reads `mv_topshot_pack_rip_values` while fresh (`20261025170047` + `20261025170715`); `idx_pack_purchases_dist_coll_nft` (`20261025173631`); concierge tool budgets now cover each tool's own fetch abort (3 code pushes, guard `concierge-tool-budget-covers-its-board-fetch`); `resolve-topshot-stubs` abort 110 s under its 120 s wall.
- **Expected, not anomalies:** a `topshot-pack-rip-values` `pipeline_runs` row every 6 h at :05 UTC (00/06/12/18), ok, ~116.6k rows (watchlist arm 420 / 780 min). `atlas-usernames-upstream-403` / `atlas-autograph-upstream-403` read `info` after an idle spell. The concierge's quiet-market note is sometimes ABSENT on deals answers (market-pulse slower than 1.5 s — by design; the answer is never dropped for it). Atlas 403s swinging 2–29 % per hour on a flat ~500 dispatches/h — Cloudflare, not us; the arms escalate on freshness.
- **A regression would look like:** `[pack-detail/pack_realized_ev] read exceeded 5000ms` back in Vercel → the rip-values refresh stopped (no ok run in 13 h → the function fell back to the ~11 s live read; read the watchlist / `cron.job_run_details`, not the page). A HIGH on those two 403 arms now means 3+ consecutive failures since the last 200 — a real block. `pack_lifecycle` timeouts recurring after 10-25 → re-EXPLAIN dist 8433 and check the new index is used. A concierge test red on `status: "timeout"` → grep that tool's path for a `fetch` whose abort outlasts its `TOOL_TIMEOUT_MS` (the guard covers branch bodies, not helpers like `annotateQuietMarket`).
- **Dated reads this thread pre-checked:** #198's first real V1 re-verify dispatch is the :24 tick ~8:24 AM PT **10-27** (48/48 runs ok, dispatched 0 until then — correct). #202's shadow log is healthy and an early read (n 34) already favours the LOW cap — re-read **~10-28** before `panini-1.4.1`.
- ⚠ **`pg_stat_statements` has not been reset since 08-12** — never justify or verify a perf change on its mean (database.md, end).

## STEER — added 2026-10-24 ~8:25 AM PT (Claude Code cloud, session_01RApKGaX7okeTFM8eidHWkw, thread close) — expected readings from the 10-23 evening honesty sweep

- **What changed (ledger 10-23 ~7:10–10:50 PM PT, 6 entries):** follows/watchlist/wallet-search/edition-stats/sniper failed reads now answer as errors or `degraded`; every collection-keyed map read in `app/api` goes through `ownLookup` (guard `a-collection-key-never-reads-object-prototype`); the Candy marketplace-status row reads `silent_since_2026_10_11`.
- **Expected, not anomalies:** a `/api/sniper-feed` response with `sourcesFailed: ["topshot-fmv"]` during a DB spell (that leg used to empty silently); 5xx (not 200 `following:false`) from `/api/teams/follow` and `/api/profile/follows` while the DB is slow, rendered as "Follow unavailable"; a 400 for `?collection=constructor` on any `app/api` route.
- **A regression would look like:** `topshot-fmv` in `sourcesFailed` on most requests with the DB healthy (then `get_editions_latest_fmv_wide` itself is failing — read its pgss row), or the new guard red on a commit (someone re-added a bare `MAP[collection]` read — use `ownLookup`, never an allowlist).
- **Still Trevor's:** #58's key. (The two `scratch_*` functions were DROPPED ~8:20 AM PT 10-24 from the dashboard editor via Claude in Chrome — `docs/audits/2026-10-24-drop-two-orphaned-scratch-functions.sql`; 0 `scratch_%` functions re-read 8:40 AM PT.)

## STEER — added 2026-10-23 ~8:04 AM PT (Claude Code cloud, session_019hvujp7QimzaHtWn641aCn, closing pass) — Panini team walk widened; read the 10-24 3:35 AM walk

- **What changed (ledger 10-22 10:34 PM → 10-23 7:58 AM PT):** player hubs `/players/<slug>`; franchise hubs carry a Panini panel; the team-walk roster went 31 → 108 targets (30 NBA · 27 MLB incl. Los Angeles / New York / Chicago · 36 NFL · 15 WNBA); the plan interleaves sports among never-walked targets. Docs: [features/player-hubs.md](../features/player-hubs.md), [features/franchise-hubs.md](../features/franchise-hubs.md) "Panini on the hubs".
- **READ the 10-24 walk (task `RPC Panini Team Walk`, 3:35 AM PT on the laptop):** `select sport, team, last_attempt_at, last_complete_at, last_listings from panini_team_walk_targets where last_attempt_at > now() - interval '18 hours' order by 3`. A Football / Womens Basketball row there ⇒ the laptop runs the 10-23 script (Trevor believes he pulled; unverified when written). ONLY Baseball rows (Arizona, Atlanta, Baltimore, Boston, Chicago) ⇒ it does not — ask Trevor to `git pull` in `%USERPROFILE%\rip-packs-city`. **Not a regression either way:** the receiver hands an old script Basketball/Baseball only, by design (the starvation guard, `LEGACY_PLAN_SPORTS`).
- **An NFL/WNBA row with `last_complete_at` set and `last_listings = 0` is a LABEL miss, not an empty team:** roster labels are teams_master's spelling, not Panini's. Fix = a roster row in Panini's spelling; do not disable the team on one empty walk. A row with `last_complete_at` NULL after an attempt is a failed walk (read `pipeline_runs` `panini-team-walk`).
- **MLB shared cities are resolved at INGEST time** from `mlb_player_club_seasons` (318 of 319 catalogued names looked up). After the Los Angeles / New York / Chicago walks, `franchise_keys` for those rows should read `MLB:dodgers` / `angels` / `yankees` / `mets` / `cubs` / `white-sox`, with ambiguous cards left in `unmapped_teams` — that remainder is DESIGNED (two clubs in the window, or Luis V. Garcia), not a resolver failure.
- **Expected movement, not anomalies:** NFL / MLB / WNBA franchise hubs gaining a Panini panel and flipping to `index, follow` (and into the sitemap via `list_indexable_franchise_hubs`) as walks land; `panini_team_listings` row count growing well past ~202k.
- **Trevor's, not a night-pass item:** `DROP FUNCTION public.scratch_20261022_get_player_hub(text);` (a scratch copy; EXECUTE already revoked; the MCP holds DROPs — never route around it). ↳ **10-24 ~8:20 AM PT (Claude Code cloud):** BOTH scratch functions (this one + `scratch_20261023_search_catalog_joined(text,uuid,integer)`) are parked as one paste-ready file, `docs/audits/2026-10-24-drop-two-orphaned-scratch-functions.sql`; pre-checks (0 deps / cron / function / repo callers) re-run 8:15 AM PT; the MCP confirmation went unanswered 4×. ✅ **CLOSED ~8:20 AM PT 10-24:** another session ran the file from the dashboard editor via Claude in Chrome; `pg_proc` `scratch_%` = 0 (re-read 8:40 AM PT).

## STEER — added 2026-10-23 ~8:21 AM PT (Claude Code cloud, session_01W7x9yCaphqxBSZRbsFKLqa, thread close) — expected readings from the 10-22/10-23 thread

- **`fmv-recalc` writes FIRST now (`c22d58963` + `20261023151316`).** Step 3's pre-purge is gone; after Step 4 inserts, `purge_fmv_snapshots_today_except` deletes today's older rows only for editions it wrote. New `extra.step3_replace_delete_error` (null when healthy). A run with `p_error` `step3_replace_delete_failed` holds its cursor — a repeated one is a real fault (lock contention or a missing grant), not a flake. `step3_delete_chunk_failed` can no longer appear. A page edition the recalc SKIPS now keeps today's row from another writer (that was the bug).
- **`drain_fmv_cold_tail` has a Top Shot "ask fell" arm (`20261023040546`), return key `ask_fell_restamped`.** Expect 0–a few per tick; Top Shot ASK_ONLY editions priced above today's ask should read ~0–2 (75 before the fix). A count back in the tens means the arm stopped seeing them.
- **Zero-yield:** `resolve-topshot-stubs` / `topshot-stub-resolver` / `allday-unmapped-resolver-tail` are SUPPRESSED with re-check conditions (`20261023132818`). `ufc-enrichment-drain` leaves the list by itself on 10-25 (window falls under 50 runs) — do not suppress it. `candy-sales-indexer` stays listed on purpose (#58).
- **All Day buyer backfill is done with the custodial band:** 8:15 AM PT 10-23 run `ok=true`, `custodial_deposit` 9, `decode_failed` 0, 4 s. Hundreds again would mean the exclusion broke.
- **Rookie boards carry the 2026 class** (`/insights/rookies`, `/insights/rookie-board` class tabs; views `topshot_2026_rookie_index` / `_cohort_stats`; `rookie_class` on `topshot_rookie_edition_board`). The Rookie Board payload is 559 rows, not 500 — the jump is the fix (it had silently dropped 51). The 2026 class fills as Rookie Debut mints; 2 rookies on 10-23 is correct. Set Completers stays 2025-only until the full Rookie Debut set exists (after 11-11).
- **Sitemap watch satisfied:** `/sitemap/3.xml` serves 2,008 `/players/` + 30 `/teams/nba/` hubs; both rookie boards are in `/sitemap/0.xml`. Search Console pickup ~10-30.
- **Ready-queue:** 10-23 handoff items 2 (demand re-read — done 10-22) and 4 (zero-yield) are CLOSED; the closing ledger heading names `scripts/demand-read.sql` and `resolve-topshot-stubs` so the queue tool sees it. Item 3 (scratch-table DROPs) still needs Trevor.

## STEER — added 2026-10-20 ~8:25 PM PT (Claude Code cloud, session_01W7x9yCaphqxBSZRbsFKLqa) — expected jumps from tonight's surface fixes

- **The /insights hub "Market pulse" strip and /insights/market-pulse JUMPED by design (`20261021025602`).** Market Pulse gained a Panini row (#2 by volume, ~$96K / ~4.9k sales a week); the hub strip now sums `sales` + `pinnacle_sales` + `panini_sales` and equals the board's rows (25,688 / $247,273 for 7 d at apply). A 7-day GMV near double the old ~$134K is the fix. The hub total and the board sum differing IS a regression.
- **Market tab All Day / Golazos rows carry an ask age again** (`20261021024344`; `get_allday_market_editions_v4` / `get_golazos_market_editions_v2`): the floor row's last on-chain check, "checked" kind. ~1,000 All Day floors are weekly-verified V1 rows and read "⚠ …old" between #198 passes: true, not a regression. The concierge still reads `get_allday_market_editions_v3`, deliberately.
- **Copy changes, not regressions:** the entity Market Cap tile says "collector-held × FMV" (no "% priced from sales" — that was the HIGH/MEDIUM share); closed markets add ", at closing prices"; overview Binder cards no longer say "Flowty"; /insights/top-sales rows name their collection; a depleted pack whose EV is already below its ask reads "a ceiling, already below the $X ask" instead of "honest value ≈ secondary ask".
- ✅ **`allday-storefront-reconcile` verified on the 8:13 PM PT run** (fix `f9c8d29bd` from the 6:35 PM steer below): `ok=true`, `sellers_unreadable_foreign_storefront: 1`.
- ⛔ **SUPERSEDED 10-23:** the "Series 2026-27 is NOT minted yet" read (10-20 7:50 PM) is history — Series 9 started on chain 10-21 9:32 AM PT and 17 editions are ingested (incl. the first Rookie Debut /500s). See nba-top-shot.md Now 1.

## STEER — added 2026-10-20 ~6:35 PM PT (Claude Code cloud, session_01QkSS3h2koLMDXGr7DJCpCn) — All Day / Golazos ask stamps are now CHECK times

- **Since `20261021003446` / `20261021004010`, All Day and Golazos asks are dated by `floor_ask_verified_at`** (last on-chain verification), worded "checked"/"unconfirmed", not "listed N ago". **Expected, not regressions:** All Day V1 floors (re-verified weekly by pg_cron 762, #198) read "⚠ ask unconfirmed Nd" on edition pages between weekly passes; Golazos edition pages now show a dated ask on 400/400 sampled editions (275 had none from the RPC before); the Market tab's All Day / Golazos rows carry NO age stamp (deliberate: the old one dated the newest listing, not the floor). A "listed N ago" caption anywhere for these two collections IS a regression. Guard: `__tests__/allday-ask-stamps-are-verifications.test.ts`.
- ✅ **Residue cleared 7:29 PM PT:** `mv_cross_collection_deals_pre20261020` dropped (Trevor approved; one-off pg_cron 770, unscheduled).
- **`allday-storefront-reconcile` was `ok=false` on one seller (`0x1a21c240c0e4e27e`) from 2:13 PM PT 10-20 — ROOT-CAUSED + FIXED ~7:05 PM PT (`f9c8d29bd`):** its storefront path points at an unloadable, unmigrated third-party `NFTStorefrontV2` (`0xeee6bdee2b2bdfc8`), so no script can read it. It now shows as `extra.sellers_unreadable_foreign_storefront: 1` with `ok=true`. Verify on the first run after deploy (8:13 PM PT). A red run naming any OTHER walk error is real.

## STEER — added 2026-10-19 ~7:35 PM PT (Claude Code cloud, Candy roadmap) — a falling Candy share is the frozen market, not a regression

- **`candy_fmv_high_med_share_pct` will fall in three steps, and each step is CORRECT** while no Candy sale is indexed. FMV 1.8.2 needs a sale in the last 30 days for MEDIUM, and the newest Candy sale is 10-11 8:21 PM PT. Read 7:20 PM PT 10-19: HIGH 6 · MEDIUM 56 · LOW 63 (49.6 %). Exits by PT week: **6 MEDIUM the week of 10-19** (first 10-21 5:27 AM PT) · **5 HIGH + 33 MEDIUM the week of 11-02** · **1 HIGH + 17 MEDIUM the week of 11-09** (last 11-10 7:47 AM PT), so ~0 % by ~11-11. Each takes effect at the next recalc. **Falsifiers:** (a) a HIGH/MEDIUM Candy edition whose newest sale is > 30 days old after a recalc means the recency rule broke; (b) a step with no matching exit date means something else moved the labels. Re-derive with the query in `docs/strategy/collections/candy-mlb.md` item 4. Do not loosen the 0.35 gate or relabel to hold the share up (decided 10-10). ↳ **10-21 ~6:30 AM PT (Cowork):** the share also moves BETWEEN exits — sales leaving the 30-day window change the dispersion read both ways (29 label moves overnight with no sale, see candy-mlb.md item 4). That is not falsifier (b); a move on an edition whose 30-day count did NOT change would be.
- **`candy_sales_stale_hours` BREACHED its 7-day backstop at ~10-18 8:21 PM PT** (191 h vs 168 h at 7:20 PM PT 10-19). That is the arm's designed page for an indefinite silence (retune `20261014235448`). The indexer is healthy: 8/8 ok, and `extra.activity_types` shows Magic Eden bids and listings with 0 fills since 10-11. **Do not raise `breach_at` or suppress it**; it stays red until a sale lands, and the open question is #58 (OpenSea key, Trevor). Re-look on 11-10 per the Candy roadmap.
- **`candy_deals_board` = 0 rows is STRUCTURAL** since the 09-25 confirmed-ask ceiling: FMV never exceeds the cheapest ask seen in 12 h (0 of 1,498 active asks below FMV on 10-19). The Candy Deals tab copy now says so. An empty Candy chip on `/insights/deals` is not a broken feed.
- **New 10-21: the overview tile "Priced from Recent Sales" (#205, `mv_collection_recent_sale_share`) reads Candy 86 % and will FALL as Candy's frozen sales age out of 30 days** (newest sale 10-11 8:21 PM PT, so it reaches ~0 % by ~11-10). Same mechanism as the share above; correct while no Candy sale is indexed. Not a regression.

## STEER — added 2026-10-19 ~6:50 PM PT (Claude Code cloud, session_011oSLq1UaGea2PqWcDHtgVS, closing pass) — what the night pass must know

- **`backward_cursor_rewinds` will list `topshot_missing_fill_offers_walk` after EVERY Monday walk. That is the deliberate weekly re-seed** (each run moves the cursor DOWN to 130290659 and walks up), not the ee90eb54c class. Established 10-19 from run 39315435036; the suppression row's text now says so and its predicate is "a walk run within 8 days" (`docs/audits/2026-10-19-missing-fill-walk-suppression-weekly.sql`). Do not re-file it; do file a rewind on any OTHER cursor.
- **The weekly workflow has already had its first `schedule` fire** (10-19 12:58 PM PT, ~5.5 h late, run 39315435036, red: call 4 `fetch failed` via the spork-proxy after 3 clean calls). So if the 10-20 08:17 UTC `scheduler-liveness` names `topshot-offers-history-backfill` never-fired, the detector is wrong, not GitHub. A red Monday run means re-read the next one; nothing was lost (the 7:24 AM dispatch had walked the range, done=true).
- **`entity_rep_nft_id` returns NULL off Top Shot since `20261019233902`** (every consumer builds a Top Shot media URL and gates on `nba-top-shot`). A NULL `rep_nft_id` on an All Day / Golazos / UFC / Panini edition grid is the fix, not a regression; a NULL on a Top Shot edition with a wmc row IS one.
- **Lint ratchet:** six more rules are now banned at zero (`no-var`, `prefer-const`, `no-unused-expressions`, `react-hooks/error-boundaries`, `no-empty-object-type`, `react-hooks/globals`), and `no-require-imports` 10 → 3 (all three in `scripts/detect-jsx-space-drop.js`, a CommonJS script loading a native `.node` binding: `require` is correct there, so it stays in the baseline rather than being suppressed). `react-hooks/refs` 2 → 1: the one left (`lib/warmup/WarmupContext.tsx`) unmasks a `set-state-in-effect` when fixed and needs a `useSyncExternalStore` rewrite, not a lint pass.
- **Added ~8:20 PM PT:** `no-unused-vars` now honours a `_` prefix on args / caught errors / array slots and `ignoreRestSiblings` (`eslint.config.mjs`), so its baseline fell 305 → 91; a NEW unused variable still reds. `/api/migrate-acquired-at` was DELETED (dead and unsafe; ledger) — a 404 on it is the fix, not an outage.
- **Added ~9:40 PM PT, closed ~10:05 PM PT:** the last unguarded `?? "0"` price read (`search-deals`) is fixed too (ledger). `extra.no_price_skipped > 0` on `topshot-flowty-unmapped-drain` means the hold is working, not a fault.
- **DECIDED ~10:20 PM PT (Trevor delegated):** Panini `panini-1.4.0` (`panini_sales` 30-day input) ships ON OR AFTER 10-24, after the 1.3.x live read — a night pass does NOT ship it (pricing-engine change; interactive session). `WarmupContext` rewrite declined. Detail: roadmap-status.md "Decisions taken — the 10-19 thread".
- **Thread closed ~10:55 PM PT:** every commit CI-green and deployed. A ~02:14Z (7:14 PM PT) cluster of 8 s market-cap / franchise-hub timeouts was one crawler minute (the Panini edition tile reads 6 ms warm); do not re-file it.
- **Nothing owed from this thread.** Its dated items are the ones already listed (10-20 series-9 verify, 10-22 demand re-read, 10-24 #181, ~11-01 #193).

## STEER — added 2026-10-19 ~7:00 AM PT (Claude Code cloud, session_01LS7PmY7M2BJn8KwzCDgH55, closing pass)

- ✅ **#189 mainnet27 walk RAN 10-19 (7:24 AM PT, run 39268593178): 766 offers recovered, 0 failed; unsourced snapshot fills 2,577.** The weekly Monday schedule now starts at 130290659 (`f1c2d7723`); a Monday `ok:false` naming the spork-proxy is the proxy, not the route. ⓘ Original steer follows. — **#189 mainnet27 leg shipped, run NOT dispatched (a data write; operator step).** `backfill-topshot-missing-fill-offers` reads heights 130,290,659 → 137,390,145 through the spork-proxy. Dispatch `topshot-offers-history-backfill.yml` with `target=missing_fills`, `start_block=130290659`, `range=200000`, `max_iters=200`. An `ok:false` naming `spork-proxy unconfigured` or `below the mainnet27 root` is the guard working; a 5xx from the proxy is the node, not the route. Do not lower the start below 130,290,659 (mainnet24–26, #181). (Done: the weekly schedule moved to 130290659 after the clean run.)
- **Still deliberately open from this thread:** the Trophy Room `<title>` keeps "on Flow" until the 10-28 Search Console read; the Collection-tab Packs sub-tab stays off for Pinnacle (no pack buy source). (`/api/public/insights/trophies` `meta.source` now names what was read: `pinnacle_catalog`, the view, or `v_insights_trophies+pinnacle_catalog` unfiltered — fixed 10-19.)

## STEER — added 2026-10-19 ~7:35 AM PT (Cowork cloud) — the new weekly #189 schedule

- `topshot-offers-history-backfill.yml` gained `schedule: 23 14 * * 1` at ~7:20 AM PT 10-19 (pushed minutes before its first slot), and its pg_cron partner 755 `topshot-missing-fill-snapshot-weekly` fired on time (7:07 AM PT, `INSERT 0 12`). **If the 10-20 08:17 UTC `scheduler-liveness` run names this workflow dead/never-fired, that is GitHub skipping a first fire, not an outage** — check for a `schedule`-event run; the next slot is Mon 10-26 ~7:23 AM PDT. Do not dispatch to "fix" the detector (a dispatch is not a schedule event); if it is still unfired after 10-26 15:30 UTC, that is a real finding.
- The other session's mainnet27 dispatch (started 7:24 AM PT) shares the workflow's concurrency group, so a scheduled run queues behind it.

## STEER — added 2026-10-18 ~6:40 PM PT (Claude Code cloud, evening block) — what the night pass must know

- ✅ **The two parked data writes were APPLIED 2026-10-18 10:06 PM PT** (Cowork cloud, one-off pg_cron jobs 752–754, one statement per `cron.schedule` call — the MCP cancelled multi-statement / DO-block forms). All Day's venue row now names `dapper_storefront_v2`; the #189 snapshot took 247 new missing-fill offer ids (21,619). The re-walk from `start_block=137390146` was dispatched 10:16 PM PT (run 39203673094) — the night pass should read its conclusion and `extra.inserted` on `backfill-topshot-missing-fill-offers` before calling #189 better or worse. Records + reverts: `docs/audits/2026-10-18-marketplace-status-allday-primary-venue.sql`, `docs/audits/2026-10-18-topshot-missing-fill-offers-snapshot-refresh.sql`.
- **1.8.1 MEDIUM rows are draining by design**, not stuck: they were computed before the 1.8.2 deploy (9:48 PM PT 10-17) and re-grade as the catalogue sweep reaches them. Read 6:17 PM PT: Golazos 3 · Top Shot 199 · All Day 25 (from 5 · 268 · 36 at 5:50 PM PT). Falsifier: any 1.8.1 MEDIUM with 0 sales in 30 days still present on 10-20. M1/M2 legs dipping as they go LOW is the decided label correction, not a regression.
- **a11y-audit now gates 4 rules over 13 routes** (adds the Sniper and a populated Collection tab). A red there is a real node on a real page, not flake.
- **New invariant:** `supabase/tests/derive_pinnacle_wmc_from_catalog.sql`. The hourly render-id pass now fills Pinnacle `player_name`; a NULL-name Pinnacle wmc row with a catalog-named render_id, older than ~1 h, is a regression.
- **Set pages:** "Combined view: N sets" now counts only sets with editions (`wnba-skyline` reads 1). The 15 editionless Top Shot `sets` rows are harmless; deleting them is Trevor's call.
- **Market Owned (since ~7:00 PM PT):** it is applied only to a wallet with at least one `wallet_moments_cache` row for the collection. `ownedApplied:false` plus the full market for an unknown wallet is CORRECT, not a regression. Eligibility derives from `EDITION_MARKET_ARMS`; a new arm gets it automatically.
- **`mcp_compute_pack_ev`** now reports a `'0'` retail price as `pack_price_missing_from_metadata` (`20261019022702`, unpinned). 983 dists with slots read that way. A re-appearing `is_positive_ev:false` with `pack_price:0` is the regression.
- **Read the CI run after every code push.** `main` sat red ~6:20 → ~7:41 PM PT under seven local-green pushes. Preflight now sees `join()`-spelled test subjects, but not variable or computed ones.
- **Trophy Room (Trevor 10-18: every supported collection usable):** tabs + scope derive from `publishedCollections()`; the view's `is_top_tier` admits each collection's top tier (Ultimate, else Legendary), Pinnacle comes from `pinnacle_catalog` (Legendary/Genesis, linking `/pinnacle/moment/<render_id>`); a UFC value reads "last seen · market closed". An empty collection tab there is a REGRESSION. **Collection-tab Packs** now covers Golazos; Pinnacle stays off: there is no Pinnacle pack buy or sale source, so its tab would show rips only. The custodian-credited opens are platform batches (99.3 %), not missing collector rips.

## STEER — added 2026-10-18 ~12:47 PM PT (Claude Code cloud, 5-hour daytime block) — what the night pass must know before it acts

- ~~`rows_written` / `rows_found` fabricated for 91 of 93 DB lanes~~ ⛔ **CORRECTED 12:59 PM PT: a regex artefact.** Only 3 functions use the 3-arg wrapper, and all 3 are fixed (pack-sim 10-18 ~12:38 PM; `refresh_fmv_confidence_precompute` and `run_refresh_pack_grail_metrics_mv_job` 10-18 ~3:24 PM PT, `20261018222342`, #195 resolved — re-read 10-19). The other 95 pass real counts. No estate-wide caution needed (#195).
- ✅ **NBA probe DONE + REMOVED 10-18 ~12:51 PM PT:** Vercel egress gets ESPN 403 and cdn.nba.com timeouts, so there is no free cloud path (#8). Nothing to do; do not re-probe.
- **Fast Break is PARKED IN PLACE (decided 10-18).** Do not hand-insert `fast_break_runs` rows or turn on `NEXT_PUBLIC_SHOW_FAST_BREAK` while projections are dead. Re-look with #8 on 10-28.
- **Cron cadence changed 10-18:** `topshot-set-series-onchain` every 10 min, `topshot-circulation-onchain` every 6 h, `topshot-pack-dist-names-onchain` every 3 h. More runs of these lanes are expected, not a regression.
- **Parallel seeder idle on `queue_full` is BY DESIGN** (resolver once a day at ~1:30 PM PT; the 10k cap protects the newest series, `20260904133105`). Do not raise the cap around the Series 2026-27 launch.
- **New 10-18 1:03 PM PT: pg_cron 750 `maint-vacuum-pack-rips` (daily 4:37 AM PT).** On 10-19, read `pack_rips` relallvisible/relpages (was 72.1 %) and `EXPLAIN (ANALYZE, BUFFERS) select * from v_allday_pack_lifecycle where dist_id = '6924'` (was 691 ms, 715 heap fetches). Record both in `pack-ev.md`. ✅ **Done 10-19 ~7:05 AM PT (Cowork):** 72.1 % → 100 % all-visible; heap fetches 901 → 95, 285 ms → 14.7 ms — in `pack-ev.md`.
- **Pinnacle #193:** read it with `pinnacle_fmv_sales_backtest('2026-10-09 14:00-07')` (HIGH n 247 of 500 on 10-18). A dispersion gate was measured and is NOT the fix.
- **Added ~3:13 PM PT (same thread): All Day / Golazos surfaces moved off Flowty's v1 rows today; expect bigger numbers.** `/laliga-golazos/market` lists **496 editions** (was Flowty's 100 rows); All Day and Golazos no longer fall back to v1 on an empty answer, so an empty filter now reads empty. The Analytics Order Book Depth card shows **All Day ~28.9k / Golazos ~4.2k asks** (was 108 / 100). The Golazos Sniper relative-deals board and tier benchmarks read `cached_listings_v2`. The concierge's search and deal tools changed the same way. None of this is a regression; a JUMP in those counts is the fix. ⛔ Do not "restore" a v1 read for these two collections: their v1 rows are Flowty-only (runbook step 0).
- **Digests and the sign-up reminder now ALSO need `RPC_SENDER_POSTAL_ADDRESS`** (C2). A `skipped: postal_address_missing` log is the designed state until Trevor sets it; `send-digest` also has a new `SEND_DIGEST_ENABLED` flag (it had none).
- **Added ~4:27 PM PT: wallet listing-verification now matches the on-chain book too** (`resolve_wallet_verification_challenges`; storefront_v2 rows dated by `ingested_at`). A `resolved_via` of `direct_v2` / `storefront_v2` / `direct` on a challenge is the new leg working, not an anomaly. #195 is closed and verified; its heartbeat-marker residue (10 pipelines logging 0) is a noted follow-up, not a night-pass ship.

## STEER — added 2026-10-17 ~7:40 PM PT (Claude Code cloud; docs-refresh thread archived) — three DATED checks handed to the night pass

This thread could not leave a runner for these: a fresh-session scheduled task gets no Supabase connector (the `connectors` parameter is unavailable for this org), and a check-in into an archived thread may not fire. **The night pass owns them.** The full SQL, verdicts and write-backs are in the inbox filing [2026-10-18T0233Z-claude-code-dated-checks-192-verify-demand-reread-193-pinnacle.md](inbox/2026-10-18T0233Z-claude-code-dated-checks-192-verify-demand-reread-193-pinnacle.md). Each item names the date it becomes due; before it, skip silently.

- ✅ **DONE 10-17 ~11:20 PM PT (Claude Code, Windows box) — #192 verified: 480/480 buyers on the 11:15 PM run, 3,211/3,211 above the cursor in `sales`; backlog 14,831 (~4 days). Do not re-run.** ~~DUE the 10-18 overnight pass — verify #192~~ (`allday-buyer-backfill`, fix `24a2ca565`, deployed ~6:25 PM PT 10-17). Read `pipeline_runs` for `allday-buyer-backfill` / `golazos-buyer-backfill` since 10-17 6:30 PM PT. Expect the first All Day run to wrap (`extra.wrapped: true`; the cursor sat at 2025-10-06, below the new 2025-10-22 floor), then runs with `buyers_resolved > 0` or an honest `ok=false` "decode wall". Verified → add a ↳ VERIFIED line under item 192 in `known-issues.md` (do not touch its first sentence) and under the 10-17 "Documentation refresh" ledger entry, and update the All Day roadmap's "Verify #192" Now item. Still 0/480 decodes at or above 2025-10-22 → it is a decode bug, not the spork boundary; file it on #192.
- **DUE on/after 10-22 — the demand re-read** for PT week 10-15..10-21, using the method of roadmap-status.md's "⭐ NEW 2026-10-15 — DEMAND READ" block, reported against that baseline (Google one-page share 19/26; paste → sign-in click 10 → 0). Write a new dated block above it, and update `roadmap-2026-10-17.md` §2 and `features/insights-and-seo.md`.
  - ✅ **DONE 2026-10-22 ~7:10 AM PT (Claude Code cloud) — do not re-run it.** Method codified as `scripts/demand-read.sql`; dated block written in roadmap-status.md; roadmap §2 + insights-and-seo.md updated. The night pass's "0 sign-in clicks" read the wrong table (`signin_click` is in `funnel_events`). Next re-read on/after 10-29 with the script.
- **DUE on/after 10-31 — re-measure #193** (Pinnacle HIGH vs a median of the last 5 sales). The method and ship gate are in the item: ≥ 500 HIGH sales since 10-11. ⛔ A pricing-engine change is NOT a night-pass ship: report the numbers in the item and the handoff. If the gate is met and last-5 still wins, queue the change for an interactive session; if the gap closed, close #193 as falsified.

## STEER — added 2026-10-17 ~9:50 AM PT (Claude Code, Windows box) — three queue items the night pass keeps re-carrying are STALE; do not re-carry them

- **"#23/#25 edge-fn drift (since 08-22)" is CLOSED** — #23 closed 09-08, #25 resolved 09-25; `edge-fn-drift` has been green daily (10-17 run: 52/52 repo bodies matched, `clean`). What was really left was R21's residue: deployed functions with NO repo source. On 10-17 the two of those still being CALLED (`pipeline-failure-alerts`, `backfill-player-names`) were landed and redeployed from git. A third live one, `compute-achievements` (weekly, invisible to a 24 h log window), was landed and repaired the same day. The 17 still deployed-only have NO caller on any source checked 10-17: cron-job.org targets (host + slug census), `cron.job.command`, DB function bodies, and repo fetch sites. (`function_edge_logs` is NOT a census: it dropped two answered scheduled calls that day.) Deleting them is optional dashboard hygiene (R130), not drift.
- **"#58: the three candy-opensea indexers fail every tick" is WRONG** — they were UNSCHEDULED 2026-10-13 6:35 AM PT (ledger; R129 refuted). They do not run, so they cannot fail. The only open part is Trevor setting `OPENSEA_API_KEY` if he ever wants them.
- **"Windows mount is behind origin / holds uncommitted edits" is DONE** — synced 2026-10-15 (the mount's unique 10-13/10-14 content was spliced into origin, `ee6e2af80`); the mount has tracked origin since.
- **WATCH (added ~3:10 PM PT 10-17), for the parallel seeder fixed in `20261017211832`:** `never_queued` = base-keyed Top Shot wmc rows of bases that have parallels, with no `topshot_moment_subeditions` row. It was **66,001** at the fix and should FALL each ~20 h cycle (`topshot_parallel_seed_state.cycles` was 4 at the first new tick). Query: `with b as (select distinct split_part(external_id,'::',1) b from editions where collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' and external_id ~ '^[0-9]+:[0-9]+::[0-9]+$') select count(*) filter (where not exists (select 1 from topshot_moment_subeditions t where t.nft_id=w.moment_id)) from wallet_moments_cache w join b on w.edition_key=b.b where w.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'`. A tick returning `truncated: true` is the fix working, not a fault. **If it does not fall across two cycles, file it.** ↳ 📏 **Read 10-18 ~1:36 PM PT (Claude Code cloud): 63,117** (66,001 at the fix → 65,864 on 10-17 9:15 PM → 63,130 on 10-18 12:33 PM → 63,117). Falling, slowly, and by design: the resolver (`backfill-topshot-subeditions`, via the 1:30 PM PT `drain-conflated-subeditions` cron) resolved a full 20,000-row batch at 1:33 PM PT (0 chunk errors, 1,242 parallels), and the seeder had sat on `queue_full` (pending 10,001 ≥ cap 10,000) since 10-17 3:31 PM PT, which is the cap protecting the newest series (`20260904133105`). Pending is now 5,589, so the seeder refills at its next :31/:57 tick. Expect ~10k/day off this backlog; do NOT raise the cap around the Series 2026-27 launch. D25 itself is RESOLVED (0 impossible serials); do not re-flag it. ↳ **Re-read 10-17 ~9:15 PM PT (Claude Code, Windows box): 65,864, and the seeder is IDLE BY DESIGN, not stuck.** `topshot_parallel_seed_state.updated_at` sat at 3:31 PM PT with `cycles` still 4 because `seed_topshot_parallel_base_targets(60, 4000, 10000)` returns `queue_full` WITHOUT touching its state row while `subedition_id IS NULL` ≥ 10,000 (it was 10,001). The only drain is the DAILY `backfill-topshot-subeditions` edge fn (1:33 PM PT, 20,000/run, ok on 10-15/16/17), so `never_queued` falls in STEPS after each 1:33 PM run (~a week for 66k), not per tick — a stale `updated_at` or a flat count between runs is NOT a fault. Judge it on the 10-18 and 10-19 post-1:33 PM reads.
- **Re-carried AGAIN on 10-18 (overnight handoff), and the pass proposed a bulk inbox archive.** The inbox is APPEND-ONLY (test-enforced); an "archival backlog" is not an item. Before writing a Queued section, check each carried line against this STEER block and drop the ones it lists.
- **"drop_scratch residue (~185 MB flowty_archive.scratch_*, SQL-editor only)" is DECLINED** (decided 10-18 ~9:20 AM PT under Trevor's delegation, Claude Code) — KEEP the tables: cheap to hold, and once the Flowty API goes dark the 10-02/03 export cannot be re-run. Do not re-carry or re-suggest the drop.
- **"Inbox archival backlog — unarchived files in the inbox, bulk archive" is DECLINED** (added 10-18 ~6:50 AM PT, Claude Code, Windows box) — the inbox is append-only and `__tests__/inbox-is-append-only-since-the-rule.test.ts` reds CI on a move. ⭐ **These `- **"<title>" is CLOSED|DONE|DECLINED|WRONG**` lines are now MACHINE-READ:** `npm run ops:ready-queue` marks a matching carried item `⛔ … do NOT re-carry` (CLOSED/DONE/DECLINED) or adds a read-this hint (WRONG = a claim inside it was refuted; the item stays). Write a new verdict in that exact shape and the next pass cannot re-carry it by accident.
- **DECIDED 10-17, do not re-carry:** #172 SHELVED (phone delivery), #190 CLOSED/declined, R130 kept, OPENSEA_API_KEY Trevor-only (roadmap-status.md "Decisions taken — the rest of the 10-17 open list").


## ⏬ Older steers rolled to [focus-archive-2026-H2.md](focus-archive-2026-H2.md): 2026-09-14 and earlier on 2026-09-24; 2026-09-18 → 2026-09-20 on 2026-10-03; 2026-10-03 → 2026-10-15 on 2026-10-24. The persistent sections below (do-not-re-flag, inbox append-only, STANDING, sentinel queue, DECIDED, RETIRED STEERS) were kept.

## STEER — do NOT re-flag these (current)

- **`check_zero_yield_lanes()` flagging `pinnacle-pack-openers` / `pinnacle-metadata-backfill` is BENIGN-INTERMITTENT, not a stall** (dispositioned 2026-10-17). Both write only on Disney Pinnacle pack-opens, which are bursty (a 6-day zero gap 10-03→10-08 self-resolved with a 10-09 burst). Every tick ok=true, 0 gql/write errors. ⛔ Do NOT add a zero-yield suppression (it would blind the 09-12 "ok-while-queues-silent" failure class). Re-open ONLY on ok=false / write_errors / gql_errors, or upstream pack-opens resuming (enqueued/windows_done > 0) with attributed staying 0.
- ✅ **2026-10-04 ~7:13 AM PT: `v_rpc_trust_health` reads 0 breaches** (re-derive before quoting). `public_board_slow_count` cleared once the 4:28 AM PT sweep was clean; its 4 slow readings were the 11:28 PM PT sweep under Flowty load. The three Panini boards that timed out the `panini-boards` snapshot got indexes (`20261004123243`, `…124114`, `…124411`), and the snapshot rebuilt at 5:52 AM PT. The line below is the PRIOR state, kept for history.
- **The three standing trust breaches are all known-class.** `panini_sale_price_capture_dry_days` (an arm that is **crying wolf** — it counts dry days on a field deliberately abandoned and replaced on 08-08, while the replacement works at ~22%; the fix is to RE-POINT the arm, not to chase the capture), `unmapped_resolution_backlog_max` (AllDay permanent floor — its own text says do NOT raise `breach_at`) [⏹ **STALE 2026-10-17 ~6:55 PM PT:** the arm is gone from `rpc_trust_health_precompute`, and All Day has **0** open `unmapped_sales` (#160 drained 10-11). The 1,080 open rows are UFC 1,054 (closed market), Top Shot 19 and Golazos 7], `public_board_slow_count` (saturation collateral; **do not characterize its direction from fewer than several days** — it has been called both "climbing" and "oscillating down" on ~1-day windows and both were fair).
- **Sentry issues titled `smoke check could not run: …` are the honest-degradation path WORKING**, not security failures. Verify against the live invariant (`check_public_security_invariants()`, `check_anon_write_surface()`) before treating one as a breach.
- **`rpc-topshot-pack-opens-history` returning `done: true` ~96×/day is a DELIBERATE STANDBY.** It looks like a dead cron on every instrument. Do not unschedule it.
- **SERIAL-FMV-MULT-CRON — BY DESIGN.** `serial_fmv_multipliers` and `serial_fmv_power_model` refresh **weekly** via pg_cron. Staleness ≤7d is expected; do not re-queue as an escalating cron-silent item.

## ⚠ DO NOT ARCHIVE `docs/overnight/inbox/` FILES (measured 2026-08-17 — a queued action that would have broken things)

The `inbox/` convention says files are "archived to `inbox/archive/` after draining", and the 08-17 handoff had ~40 Aug 9–14 files queued to archive "once push is restored". **Do not run that.** Those files have become **permanent citation targets**: they are referenced by exact path from `CLAUDE.md` (4), `docs/overnight/ledger.md` (many), a dozen handoffs, the roadmap, `docs/sessions/2026-08.md`, **four committed `supabase/migrations/*.sql` files**, and **`lib/analytics/rpc-with-retry.ts:268`** (live product source). Moving them breaks every one of those, and migrations are immutable history that must not be edited to chase a path.

Evidence this has already bitten: `inbox/archive/2026-08-10T0515Z-…md` cites `inbox/2026-08-09T1941Z.md` — an already-archived file pointing at a still-live inbox path.

**The convention and the citation practice are in conflict, and the citations win.** Treat `inbox/` as append-only. If the directory's size becomes a real problem, the fix is a redirect/stub or an index — not a `git mv`. ⚠ **THIS IS ENFORCED: `__tests__/inbox-is-append-only-since-the-rule.test.ts` bans any filing dated on or after the rule from sitting in `archive/`.** ⛔ **And the 2026-08-24 night-pass handoff queued the OPPOSITE** — *"a push-capable pass should archive resolved items"*, calling ~200 live filings *"the accrued cost of the long NO-PUSH streak"*. **They are not debt; they are the intended steady state.** A push-capable pass tried it on 2026-08-24 and the guard stopped it. **Retire a filing by annotating it in place with a ✅ RESOLVED section — never by moving it.**

## STANDING (added 2026-06-22 — do NOT drop on the next focus rewrite) — pg_cron failure check

Every monitor + night-pass health sweep, also run `SELECT * FROM check_pgcron_recent_failures();` — this surfaces the pg_cron-internal failure class that `detect_stalled_pipelines()` CANNOT see (it watches `pipeline_runs`, not `cron.job_run_details`). Empty array = all pg_cron healthy. A listed job is a real finding **only if its `last_run` is AFTER the relevant same-day fix landed**; a failure timestamp that predates a fix is a STALE pre-fix run that clears on the job's next tick — do NOT alarm on it. A genuinely-recent pg_cron failure = HIGH-PRIORITY inbox candidate. (Also permanent in both task SKILL.md health-sweep sections; this note is belt-and-suspenders.)

## SENTINEL DECISION-QUEUE (2026-08-17 PT) — dispositions, so nobody re-derives these

The queue's own warning was that **re-derivation is this project's recurring cost**, and three of its five
items had already been measured elsewhere. Current state:

- ✅ **Item 5 (`pinnacle-nft-resolver`, ~900 null-edition rows) is CLOSED — it is the 08-15 catalog gap.**
  `pinnacle_sales.edition_id` FKs to `pinnacle_editions` (551 rows); the editions live only in
  `pinnacle_catalog` (2,561). Re-measured 08-18T0112Z: `distinct_editions=161 · in_editions=0 ·
  in_catalog=161`, up from 114 on 08-15 (**+41 % in three days**). Filed:
  `inbox/2026-08-18T0112Z-pinnacle-null-edition-pool-is-the-catalog-gap-…md`.
  ⛔ **Do NOT "park the unresolvable rows"** — they are not permanently unresolvable, and parking them
  hides a widening gap. ⚠ The resolver's `failed: 0` means it **never reaches** these rows (946 of 954
  have `resolution_attempts = 0`), not that it declines them gracefully.
- ⏸ **Item 1 (pack-EV `fmv_current` JOIN) — mechanism CONFIRMED, still correctly unshipped.** Fully
  measured already in `inbox/2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md`
  (~3,100× — 335 buffers vs 1,046,192). ⚠ **The queue framed this as one coordinated migration because
  "the function is pinned AND two of three are unmeasured". Those two facts are DECOUPLED — verified
  08-18 — and splitting them makes the expensive half shippable on its own:**

  | function | pinned? | measured? |
  |---|---|---|
  | `compute_pack_ev_per_edition_weighted` | **YES** — `supabase/tests/compute_pack_ev_per_edition_weighted.sql`, PINS entry at `__tests__/db-invariants-drift-guard.test.ts:170` | **YES** — jobid 71's callee, confirmed by the timeout CONTEXT; ~100 min/week of `cron_heavy` for zero rows |
  | `compute_pack_ev_from_pool` | no pin file | no |
  | `compute_pack_ev_from_pool_tier_weighted` | no pin file | no |

  So the **pinned one is the measured one**, and it is the one actually burning the budget. It can ship
  alone (migration + pin `.sql` + repoint the PINS migration name); the two unpinned ones need
  measurement but **no pin work**, and must not gate it. ⛔ Never `CREATE OR REPLACE VIEW fmv_current`
  (resets `security_invoker`); fix the CALLERS via a lateral accessor. Measure in a quiet window —
  during a saturation spell no timing is interpretable.
- 🔑 **Item 2 (`wallet-username-resolver`) is OPERATOR-ONLY — it is not pg_cron.** Caller enumerated
  08-18: absent from `vercel.json` (36 crons), pg_cron (94 jobs), GHA and in-repo fetches. It is
  **cron-job.org**, firing `POST /api/cron/resolve-wallet-usernames` 2×/hour. Trevor chose lever (a),
  cut the cadence → **every 3 h**. Sizing: 72.3 % of runs fail, and the failures still pay the full
  21-day `sales` scan before `wallet_usernames_unresolved`'s `statement_timeout=60s` kills them, for
  ~31 usernames/day. ⚠ Cadence only — **do not narrow the 21-day window** (breaks the 14-day retry).
- 🔍 **Item 3's lever is NOT the index alone.** The cost is in `aggregate_saved_wallet_stats`, whose
  `top_tier` **correlated subquery re-scans `wallet_moments_cache` once per `collection_id`**, and no
  index carries `tier` (confirmed: 14 indexes, none include it; `idx_wmc_cohort_cover` is now **464 MB**,
  not 458). Fold the subquery into the existing `GROUP BY` before considering a wider index — a fold
  costs no write amplification on a 98 %-non-HOT table.

⚠ **Measurement hygiene, learned the hard way 08-18:** the Supabase MCP 60 s cap abandons the RESULT, not
the query — a "timed out" EXPLAIN keeps running (seen at 86 s) and retrying it stacks copies onto the
saturation being measured. Take a positive control first (`count(*) FILTER (WHERE wait_event_type='IO')`
over `pg_stat_activity`); if most active sessions are in IO wait, **every duration that hour is
uninterpretable** — compare Buffers, never wall time.

## STANDING — read the three daily instrument LOGS, not their badges (added 2026-08-22)

Three credentialed detectors run daily and are the only things that can see their rot classes:
`edge-fn-drift` (06:40Z) · `db-pin-staleness` (07:20Z) · `migration-parity` (07:40Z). **Measured 2026-08-22:
edge-fn-drift red 14 consecutive runs, db-pin-staleness red 13, migration-parity 14/14 green — and BOTH red
ones are LOUDLY CORRECT, not broken.** 25 edge functions are not running `main`; 6 of 187 DB pins no longer
match live. Details: known-issues **#23**, **#24**.

⚠ **Nothing surfaces them (#25).** The sentinel — the thing actually read — has no GitHub Actions arm, so a
correct detector can stay red indefinitely and nobody notices. Until that is fixed, **reading these three
logs is a MANUAL step in any health sweep**, and CLAUDE.md's rule applies literally: *check the LOG, not the
badge* — a permanently-red instrument and a broken one look identical.

✅ **#24 is RESOLVED as of 2026-08-22 — all six pins re-pinned, assertions reviewed, not merely repointed.**
The warning that stood here (repointing without reviewing the assertions converts a working alarm into a
silent green) was honoured: every pin got its own diff, and five gained mutation-tested assertions for the
behaviour that had drifted. ⚠ **VERIFY, do not assume:** the 07:20Z `db-pin-staleness` run should now report
**187 clean, 0 needing attention** — its first green since 2026-08-03. If it names a pin instead, read WHICH
before reopening. 🚨 **IT DID NAME PINS — this prediction was FALSIFIED on 08-23 and the reason is durable;
see the 2026-08-23 STEER above.** Closure is a moment, not a state: a same-day rewrite of a pinned function
re-opens the instrument within hours. Recipe + what the six taught: [database.md](../reference/database.md).

⚠ **#23 and #25 remain OPEN and are operator-blocked.** 25 edge functions are still not running `main`
(redeploy needs both `deno.json` in `files` AND `import_map_path`, or a stale-but-working function goes
hard-down — and the list includes off-limits `compute-*-pack-ev` / `ingest-*`). Nothing still reads the
daily detectors; that fix is a sentinel arm keyed on a failure STREAK, blocked on putting a GitHub token
with `actions: read` into Vercel env.

## DECIDED 2026-08-22 — two open decisions closed, so nobody re-opens them

- ✅ **pg_cron jobid 70 / the `cron_heavy` privilege question: do NOT grant, no grant is needed.**
  `postgres` IS a member of `cron_heavy`, and `cron_heavy` already holds EXECUTE on `cron.schedule` and
  `cron.unschedule` — only `cron.alter_job` is missing, and `cron.schedule` upserts on
  `(jobname, username)`, so rescheduling under the job's own role updates it in place. Granting
  `alter_job` would widen a privilege to buy a capability the role already has by another door.
  ⚠ **The blocker is the HARNESS, not the database** — the Claude Code auto-mode classifier denies
  `SET ROLE`. The two-line self-checking recipe (and what to do if it returns a jobid other than 70) is
  in **known-issues item 19**, which has been corrected: its old "NO session-reachable role can
  reschedule" headline was **REFUTED**. **Transferable:** *"the sandbox could not do it" is not evidence
  that the DATABASE forbids it* — that conflation turned a two-line fix into a privilege-grant proposal.
- ✅ **The FMV-confidence accuracy meter: the destination is a NIGHTLY MATERIALISED TALLY**, not a
  cheaper in-band query. Rationale in §7 of
  `inbox/2026-08-22T1745Z-the-headline-accuracy-metric-is-unreadable-20h-a-day-…md`. The short form: a
  3.3× cheaper query still runs in-band and can still be killed in a spell — it lowers the odds without
  removing the dependency; and **a GATE metric needs a SERIES, which the in-band rewrite does not
  provide at all**. ⚠ **The lateral rewrite is NOT the alternative — it is the tally's WRITER**, so the
  23:10Z measurement (`trig_01H3p6o5iB7yyjLVzrbbviaA`) keeps its full value and has been repointed at
  that question. ⚠ **The tie check is now BLOCKING**: a tally is computed once and read all day, so an
  arbitrary tie-break is frozen into the published number. ⚠ **New third state for the redesign:
  STALE** — a stored tally that silently ages is worse than a query that loudly times out, because a
  timeout is falsifiable. Nothing has shipped: no table, no writer, no migration.

## RETIRED STEERS — these were in this file and are now WRONG; do not re-add

- ⛔ **"TS on-chain unmapped spike — do NOT skip/retire this class."** `topshot-flowty-unmapped-drain` was **deliberately RETIRED 2026-08-16** (schedule removed from `vercel.json`, verified absent) because its queue reached **0 open** and proving emptiness cost a full backlog scan on ~73 ticks/day. The old steer now argues against a decision that was correctly made.
- ⛔ **"evm-transfers-ingest Base-429 — benign, don't chase."** That cron was **disabled 2026-08-02** as pure waste (`evm_nft_transfers` holds ZERO rows; absent from `vercel.json`, GHA and pg_cron). There is nothing left to not-chase.
- ⛔ **"`unmapped_resolution_backlog_max` self-clears <100 in ~1–2 days."** It did not. It is **291** and is now understood as an AllDay **permanent-class floor**, continuously replenished. Do not wait for it to clear and do not raise its threshold.
- **The whole 2026-06-24 studio-platform post-ship watch** (3 backfill routes, the watchlist follow-ups, the TS dead-media tail, the spork-proxy correction, the UFC studio resolver) — all shipped and long since folded into `CLAUDE.md` + the ledger. Kept out of this file to stop it decaying into an archive again.
