# Focus — 2026-08-17, steers appended through 2026-09-05 (accuracy-gate phase; the June studio-platform program is HISTORY)

⚠ **This file was 54 days stale until 2026-08-17** (it was still the 2026-06-24 studio-platform post-ship watch). That is not merely untidy: three of its steers had gone **actively wrong**, and a night pass following them would have been misdirected. The obsolete steers are listed at the bottom under "RETIRED STEERS" with the reason each died, so nobody re-adds them from an old copy. The June program's detail is **not lost** — it lives in `docs/overnight/ledger.md` and `docs/handoff-2026-06-24-studio-platform-gql-deep-history.md`.

**Rewrite rule for whoever edits this next: a focus file STEERS the next night, it is not an archive.** If a section is describing something that shipped more than ~a week ago and is not still a live trap, move it to the ledger and delete it here. A stale steer is worse than no steer.

## STEER — added 2026-10-30 8:31 AM PT (Claude Code cloud, session_014vX7Q7qM7twrBUY9w4M9yP) — Dapper's pack index is frozen; the Pack Sniper now says so (#218)

- **The 10-29 "watch" below is ANSWERED: it is a frozen upstream, not a quiet market.** `pack_ask_state` newest change TS 10-29 8:08 AM PT, AD 6:28 AM PT; `topshot_pack_sales_history` stopped with it (same Dapper GraphQL). The chain did not stop: 428 Top Shot secondary pack sales in `pack_purchases` since. Nothing in our pipeline failed, so do not "fix" `snapshot-pack-asks` — it is diffing faithfully.
- **Expected, not anomalies:** the Top Shot Pack Sniper shows "Asks NOT live — feed stalled" plus a red-bordered notice with the chain count, until the first snapshot after Dapper's index moves. All Day will NOT show it (1 chain pack sale in 36 h — the witness cannot tell quiet from frozen there). The Pack Market board reads chain data and is unaffected.
- **A regression would look like:** the notice while `max(ask_changed_at)` is < 2 h old (false alarm), or "Live asks" while the book is > 2 h old AND `pack_purchases` shows ≥ 10 TS secondary sales since (witness read failing — `meta.book.chainSalesSince` will be null).

## STEER — added 2026-10-29 11:11 AM PT (Claude Code cloud, session_014vX7Q7qM7twrBUY9w4M9yP) — expected readings from the 10-29 morning; two DB writes still need Trevor

- **Expected, not anomalies:** (1) Top Shot boards show "Set · Parallel" ("Base Set · Rippled") on first-mint, squeeze, top sales, serial premiums, perfect-mint and underpriced serials (#216). (2) The /insights hub squeeze tile reads ~5,770 (≥50 % only), not ~14,500. (3) Pack Reality's sleepers lose "Arike's Record Night" (2864% → about model). All Day pack reality means fall where 72 rips were re-priced (#217 repairs, 10:42 and 10:58 AM PT). (4) The All Day degraded notice says trading restarted at low volume. (5) Edition / moment / wallet table read "capped at sales" on `_salescap` / `_histcap` rows (#215).
- **A regression would look like:** a pack-reality dist whose mean rests on MANY pulls sharing ONE value (the #217 shape; re-price, then size the stale leg); two board rows with identical player · set and different multipliers (a parallel lost its name); the hub squeeze tile equal to the squeeze view's total row count.
- **Watch (unexplained at filing):** `snapshot-pack-asks` Top Shot `changed` = 0 every tick from 9:00 AM PT 10-29 (1–11/h overnight). Upstream (Dapper Studio search) returns the same 2,035 dists each tick. That could be a quiet pack market or a lagging search index; it can't be checked from the cloud. If it is still 0 at the night pass, compare a dist's ask on the live Top Shot pack market.
- **Still needs Trevor (MCP approval prompts never reach this client):** the Candy sentinel silence migration (loudness → off plus a zero-yield suppression), staged as `docs/proposals/candy-sentinel-recorded-silence-STAGED-MIGRATION.sql`, and part (2) of `docs/proposals/cadence-bridge-chain-arrivals-STAGED-MIGRATION.sql` (the lapsed pinnacle-pull-chain DELETE). And `docs/proposals/reprice-drifted-high-value-rips-STAGED-MIGRATION.sql` (#217's narrowed fix: a daily lane re-pricing high-value rips whose value drifted > 3×, ~+10 % on the backfill's daily IO); its apply hit the same unanswered prompt.

## STEER — added 2026-10-28 ~10:55 PM PT (Claude Code cloud, session_014vX7Q6Cam1dR9kzm4npa2L, thread close) — ONE staged migration needs a DB write Claude could not get approved; two expected readings

- ✅ **10-29 ~8:25 AM PT: parts (1)+(3) APPLIED** as `20261029152527` (no DELETE, so no prompt); the arm reads `degraded: []`. Only part (2), the DELETE of the lapsed `pinnacle-pull-chain` bridge, is still staged in the same file (harmless: one `expired_exemptions` line). Original text follows.
- **Staged, NOT applied:** `docs/proposals/cadence-bridge-chain-arrivals-STAGED-MIGRATION.sql`. Every write from that session (apply_migration ×4, execute_sql ×1) raised a Supabase MCP approval prompt that went unanswered within 60 s. It (1) bridges `chain-arrivals` in `cadence_exempt_lanes` to 11-05 (demand-gated since `20261023213517`; the arm's baseline median is clean from 11-04), (2) deletes the lapsed `pinnacle-pull-chain` bridge (lane clean), (3) clears the Cadence Collapse ack that expired 10-01 (its own falsifier is unmet). Apply through apply_migration (or the dashboard SQL editor with Trevor present, as #211 B2 was), commit under its version, delete the staged file. **After 11-04 drop part (1).** Until it lands, Pipeline Sentinel reads CRITICAL on Cadence Collapse for chain-arrivals; that is this, not a caller fault.
- **Expected:** analytics-smoke logs `ok:false` every 30 min while All Day sales are stale, with `extra.telegram_suppressed: true` on all but one tick per 3 h (`72b96bb84`). `pinnacle-resolve-buyers` now logs no-work runs (`extra.no_work: true`), so its cadence ratio recovers on its own.
- **A regression would look like:** analytics-smoke `telegram_sent: true` on consecutive ticks with the same failing set (the gate stopped suppressing), or `telegram_suppressed: true` with a failing set that never paged (the key is not the set).

## STEER — added 2026-10-28 ~7:25 AM PT (Cowork cloud) — #58 is CLOSED and NOT Trevor's; Candy's stale-sales breach is retired by design

- **Do not carry "#58 OPENSEA_API_KEY — Trevor-only" any more.** #58 was settled 2026-10-25 by a Solana collection census: Candy secondary trading STOPPED on 10-11, it did not move venues, so no key is needed. The 10-19 steer (rolled to focus-archive-2026-H2.md on 10-28) ("do not raise breach_at or suppress it … the open question is #58") is superseded: the question is answered.
- **What changed (`20261028141905`):** `candy_sales_stale_hours` keeps its indexer-health half (breach_at 0 on no ok run in 7 h / > 50 unresolved), but while `v_collection_marketplace_status.candy_mlb.secondary_status = silent_since_2026_10_11` its silence backstop is a RE-VERIFY clock — it breaches ~11-27 6:15 AM PT, 30 days after the row's `last_verified_at` (re-verify the row then: newest Candy sale, indexer health, and bump `last_verified_at`). New arm `candy_revival_sales_since_recorded_silence` (breach_at 1) fires on the first Candy sale after 10-11 PT.
- **Also stop carrying these (the 10-28 1 AM handoff listed them as routed-to-Claude-Code; re-derived 7:50 AM PT, all CLOSED):** (a) **#HF hot-floors live sessionization** — RESOLVED 10-27 ~7:45 AM PT by Claude Code (`20261027140941`; All Day on `allday_hot_floors_snapshot` since 10-26): every board reads a precomputed row; pg_cron `allday-` / `topshot-` / `panini-hot-floors-snapshot` 96/96 · 96/96 · 48/48 ok in 24 h (resolution appended to inbox `2026-10-27T0309Z-…hot-floors…`). (b) **`get_panini_franchise_panel` perf** — pgss mean 566 ms over 2,693 calls, no franchise-panel error group in Vercel 24 h; the 13.8 s max is a cumulative-since-restart figure, not a new event. (c) **`refresh_panini_offer_spread()` self-collision** — one failure ever (10-25 10:10 PM PT), 48/48 ok since. Keep only **`panini_deal_board` / `_all` cache-warm timeout** as a WATCH (≤ 2/day, falls back to the last good snapshot, 0 user-facing errors in 24 h; a rewrite measured no buffer win, ledger 10-27).
- **Expected:** trust breaches 0; sentinel Trust Health ok; `candy_sales_stale_hours` value keeps climbing (~395 h on 10-28) while ok — that is correct. **A regression would look like:** the revival arm > 0 (Candy traded — update the candy_mlb row, do not suppress the arm), or `candy_sales_stale_hours` BREACH with breach_at 0 (the indexer itself stalled).

## STEER — added 2026-10-25 ~8:45 PM PT (Claude Code cloud, session_011fh9vTVkSG2QPpsL5ihQbc, thread close) — expected readings from the ULTIMATE / Sniper / honesty-sweep evening

- **Expected, not anomalies:** (1) ~19 ULTIMATE editions now carry a NO_DATA `ultimate-v1` row (the writer retires its own price when the model finds nothing; `pipeline_runs.extra.retired_no_data` counts them); the four Kon Knueppel Signature Series /1s read no FMV. (2) `/nba-top-shot/sniper` shows FEWER #1 / perfect-serial deals: small editions' #1 now prices off `serial_fmv_estimate` (~3× base, not 8×), so many fall out; large editions' #1 prices HIGHER. (3) Sniper cards name series "25-26" / "S1", never a bare "8" / "0". (4) Top Shot moment pages now show a "Listed" ask when `ts_listings` holds one — before tonight every Top Shot moment read "Listed —" (`cached_listings_v2` holds no Top Shot rows). (5) Analytics panels read "Loading…" / "Couldn't load" instead of an empty chart; edition "24h change" reads 0.0% when the last move is older than yesterday. (6) Rookie Board set headers read "Series 2025-26", not "Series 8"; Pack Sniper's ratio tiles read "—" on an empty book; Pack Reality's first two buckets read "$0 exactly" / "$0.01–$10".
- **Not a regression — known limit:** a Top Shot moment with no `ts_listings` row still reads "Listed —". `ts_listings` is the 24 h Atlas window, not the whole book, so the dash means "not seen", never "not listed". Don't "fix" it by reading absence as a fact.
- **A regression would look like:** a Sniper #1 card whose Adj. FMV is exactly 8 × base FMV with a HIGH/MEDIUM base and a `serialFmvEstimate` present (the re-price was bypassed); a moment page quoting a `ts_listings` ask older than that NFT's latest sale (the ghost check was dropped).
- **Re-read due ~10-30:** #213 (All Day team-label rows). ↳ **10-29 (Claude Code cloud): #213 closed at ~8:30 AM PT, then RE-OPENED ~9:00 AM PT.** `/nfl-all-day/edition/1919` shows the defect on a page collectors reach. A premium-serial cap rule (exclude #1 / jersey / last mint) was measured: better WAPE in every cell, but one within-±25 % cell loses 1 sale. Re-read ~11-05, once All Day has a week of post-reopen trading. The same pass read the #208/#209/#210 weekly exits: #210 TS met, #208 falsifier not met but the exit not met either (the uncapped no-history rows), #209 n too small. Numbers are on each item.

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
- **Dated reads this thread pre-checked:** #198's first real V1 re-verify dispatch ✅ **read 10-27 ~10:15 AM PT:** it began at the 7:24 AM PT tick (12 requests, 579 ids), drained 8:24 / 9:24 — 1,233 listings verified live on chain, 0 closed, 0 HTTP errors, 0 timeouts (the Cadence script can answer gone / ghost / purchased; the 10-20 sweep had already closed the 464 dead ones). #202's shadow log is healthy and an early read (n 34) already favours the LOW cap — re-read **~10-28** before `panini-1.4.1`.
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

## ⏬ Older steers rolled to [focus-archive-2026-H2.md](focus-archive-2026-H2.md): 2026-09-14 and earlier on 2026-09-24; 2026-09-18 → 2026-09-20 on 2026-10-03; 2026-10-03 → 2026-10-15 on 2026-10-24; 2026-10-17 → 2026-10-20 on 2026-10-28. The persistent sections below (do-not-re-flag, inbox append-only, STANDING, sentinel queue, DECIDED, RETIRED STEERS) were kept.

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
