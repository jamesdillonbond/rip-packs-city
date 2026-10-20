# Focus — 2026-08-17, steers appended through 2026-09-05 (accuracy-gate phase; the June studio-platform program is HISTORY)

⚠ **This file was 54 days stale until 2026-08-17** (it was still the 2026-06-24 studio-platform post-ship watch). That is not merely untidy: three of its steers had gone **actively wrong**, and a night pass following them would have been misdirected. The obsolete steers are listed at the bottom under "RETIRED STEERS" with the reason each died, so nobody re-adds them from an old copy. The June program's detail is **not lost** — it lives in `docs/overnight/ledger.md` and `docs/handoff-2026-06-24-studio-platform-gql-deep-history.md`.

**Rewrite rule for whoever edits this next: a focus file STEERS the next night, it is not an archive.** If a section is describing something that shipped more than ~a week ago and is not still a live trap, move it to the ledger and delete it here. A stale steer is worse than no steer.

## STEER — added 2026-10-19 ~7:35 PM PT (Claude Code cloud, Candy roadmap) — a falling Candy share is the frozen market, not a regression

- **`candy_fmv_high_med_share_pct` will fall in three steps, and each step is CORRECT** while no Candy sale is indexed. FMV 1.8.2 needs a sale in the last 30 days for MEDIUM, and the newest Candy sale is 10-11 8:21 PM PT. Read 7:20 PM PT 10-19: HIGH 6 · MEDIUM 56 · LOW 63 (49.6 %). Exits by PT week: **6 MEDIUM the week of 10-19** (first 10-21 5:27 AM PT) · **5 HIGH + 33 MEDIUM the week of 11-02** · **1 HIGH + 17 MEDIUM the week of 11-09** (last 11-10 7:47 AM PT), so ~0 % by ~11-11. Each takes effect at the next recalc. **Falsifiers:** (a) a HIGH/MEDIUM Candy edition whose newest sale is > 30 days old after a recalc means the recency rule broke; (b) a step with no matching exit date means something else moved the labels. Re-derive with the query in `docs/strategy/collections/candy-mlb.md` item 4. Do not loosen the 0.35 gate or relabel to hold the share up (decided 10-10).
- **`candy_sales_stale_hours` BREACHED its 7-day backstop at ~10-18 8:21 PM PT** (191 h vs 168 h at 7:20 PM PT 10-19). That is the arm's designed page for an indefinite silence (retune `20261014235448`). The indexer is healthy: 8/8 ok, and `extra.activity_types` shows Magic Eden bids and listings with 0 fills since 10-11. **Do not raise `breach_at` or suppress it**; it stays red until a sale lands, and the open question is #58 (OpenSea key, Trevor). Re-look on 11-10 per the Candy roadmap.
- **`candy_deals_board` = 0 rows is STRUCTURAL** since the 09-25 confirmed-ask ceiling: FMV never exceeds the cheapest ask seen in 12 h (0 of 1,498 active asks below FMV on 10-19). The Candy Deals tab copy now says so. An empty Candy chip on `/insights/deals` is not a broken feed.

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

## STEER — added 2026-10-15 ~6:35 AM PT (Claude Code cloud; CX / UI / concierge thread of 10-14 archived)

- **✅ DONE 2026-10-16 9:22 AM PT — held: the 5:14 PM tick logged `suppressed_unchanged` 2 and every later delivery names a different listing/ask (ledger 10-16).** ~~Deal-alert repeat fix — decisive read is 2026-10-15 ~5:14 PM PT~~ (the daily-mode subscription's UTC-midnight tick). Expect NO new `alert_deliveries` row for `nba_top_shot:51:1878` (ask 0.46) or `nba_top_shot:58:1975` (ask 0.25) unless the ask changed, and the `alerts-dispatch` run row's `suppressed_unchanged` ≥ 1. The 10-14 5:14 PM deliveries of those two (`dedup_bucket` with no `:` fingerprint) were the LAST run on the old body — not a failure of the fix. A new row carrying the SAME ask after 10-15 5:14 PM IS a regression (`20261015002500`, pin `supabase/tests/dispatch_due_deal_alerts.sql`).
- **`fmv_alerts.armed` / `fmv_*` keys on the alerts-dispatch run are NEW (`20261015053922`).** `fmv_alerts` holds 0 rows, so `fmv_scanned 0` is the designed state. `/api/check-alerts` logging no `fmv_errors` key is by design: it no longer sends user FMV alerts.
- **Candy shows "No sales indexed" / "None indexed" on purpose** while Magic Eden's Candy feed is silent (since 10-12) and OpenSea is unkeyed (#58). Not a broken page; do not "fix" it back to $0.
- **DONE 2026-10-15 ~1:00 PM PT (`20261015195905`):** v1 Pack Reality MVs dropped, with the zz_probes, the superseded Market functions and the permanent golazos_sales_v1_backfill suppression. The last one, the redundant Panini owner-lower index, was dropped ~3:25 PM PT (`20261015222529`); `docs/pending-sql` holds nothing from 10-14/10-15.
- **Watch, ~2 weeks (to ~10-28):** `concierge_opened` from the edition-page FMV "?" and the team-checklist "?" (R73's named fallback). Under ~1 real open/week on the fixed instrument means discoverability is still the problem, not the answers.

## STEER — added 2026-10-03 ~6:30 AM PT (Claude Code cloud; replaces the spent 09-18 → 09-20 steers, rolled verbatim to the archive)

No live steer is owed by a clock. What a night pass needs to know that the ledger top does not say in one line:

- **pack-mint-probes `failure_rate` (medium) is EXPECTED to stay lit** while the backward walk is on the mainnet24 historical node (heights ≤ 85,981,134). #166 (`20261003045659`) gives node faults 12 attempts; `failed` should hold at the by-design "window missed" rows. **Re-open trigger:** probes with `status='failed' AND attempts >= 12` growing. Do not lengthen the request timeout — measured harmful 10-02.
- **Scratch Flowty-export jobs are GONE (re-verified 2026-10-03 ~2:30 PM PT: no `cron.job` row named `scratch%` or 673/674/676/680).** A `pg_net_http_400/429` HIGH from here on is NOT the export. Its results stay in `flowty_archive.scratch_20261002_*` / `scratch_20261003_*` (**16 tables + 15 `scratch_*` fns, ~185 MB**, not anon-reachable; re-counted 10-03 ~7:30 PM PT) — Trevor's data; drop only on his word. **The drop is written: `scripts/flow-wallet-walk/drop_scratch.sql`** (fn bodies preserved in `scratch_functions.sql`); `execute_sql` AND `apply_migration` of it both time out awaiting dashboard approval, so it needs the SQL editor. Keep `flowty_archive.storefront_purchased_listings_2023` and `storefront_sales_2023_flowty_index` — those are migrations, not scratch.
- **Panini laptop walks — first live run of the deadline fix is 2026-10-04 3:35 AM PT** (`5371a12b9` team walk, `691166bba` collector walk; 3 of 5 prior team walks hung ~130 min on a Cloudflare tab). **Check:** `~/panini-team-walk.log` has an `end rc=` line well before 6:15 AM and no `WATCHDOG`; `pipeline_runs` `panini-team-walk` shows a finish for every heartbeat. A `the tab hung; opening a fresh one` line followed by more pages is the fix WORKING. Detail: `docs/features/franchise-hubs.md` (team walk section).
- **DONE 2026-10-03 (do not re-queue):** #163 routes deleted; DEP0169 silenced (`node-fetch` in `serverExternalPackages` — a DEP0169 group RETURNING means that entry was dropped or the SDK changed transport); `atlas-editions` stalled-set HIGH fixed at the retry order (`20261003151308` — **re-open** if > 0 stalled sets on two ticks ≥ 1 h apart); Golazos `badge_editions.low_ask` has ONE writer (the on-chain reconciler) — the Flowty compound-key write is gone from `golazos-listing-cache`. **Flowty independence needs no build** (FMV ask leg reads no Flowty data); only teardown remains, on the day Flowty goes dark. Also DONE 10-03: **#164 verified live** (concierge watchlist + single-edition alerts write, show on `/alerts`, remove; `fmv_alerts`/`watchlist` are back at 0 because the test rows were removed, so 0 is NOT a regression); `/alerts` makes no channel claim until its read succeeds; `public.scratch_flip_probe` RLS on, then DROPPED ~1:21 PM PT (scratch tables belong in `flowty_archive`).
- **`sync-nba-projections` alert mute now expires 2026-10-28** (moved from 10-14, #8): the arm returning then is the season re-look, not a regression.
- **Added ~7:05 PM PT 10-03 (Claude Code cloud):** (1) `pg_net_http_403` CRITICAL was the two 10-03 Atlas supply lanes (`atlas_supply_requests`, `topshot_atlas_pack_requests`) missing from `check_edge_fn_http_failures()`. They now file as `atlas-supply-upstream-*` / `atlas-pack-supply-upstream-*` (info; high on a stale clean drain) (`20261004015738`). A `pg_net_http_403` row from here on is a lane nobody attributed: join its id to every `*request_id` table before calling it unknown. A `pg_net_http_400 "height range 4999 exceeds maximum allowed of 250"` at 6:48 PM PT and a burst of 10 Google-front-end `403 Forbidden` at 4:54 PM PT had NO pg_cron dispatcher in their windows. They were session probes and aged out on their own. (2) **Another session's `flowty-index-harvest-scratch` (jobid 693, every 20 s, `flowty_archive.scratch_fih_tick`) was LIVE at 6:55 PM PT and `flowty_archive.flowty_index_sales` was 996 MB.** It isn't on the drop list and it belongs to that session/Trevor. If it is still running with no owner on the next pass, file it; do not unschedule it. (3) **Dune: Trevor deferred buying a plan (~6:55 PM PT).** The Rigged Dune query stays parked. Do not re-queue it as an open item. (4) `panini-collector-walk` `failure_rate` (3 of 10) is the 10-min per-walk cap on three big rotation profiles. The walk now starts at a day-rotated collection (`walkOrder`), so their later collections stop being skipped forever. They will still read `ok=false` (partial) until a walk finishes inside the cap, and that is honest.
- **Fast Break has NO active run (decided 2026-10-03):** `fast_break_runs.is_active` is false on both finished playoff runs, so every surface shows its designed off-season state. When Top Shot announces the 2026-27 run, insert it with `is_active = true`.

## STEER — added 2026-10-04 ~9:30 AM PT (Claude Code cloud, Panini thread archived)

- **Panini residential walk is on a 2-hour schedule since 10-03 evening** (FULL at 2/6/10 AM-PM PT, WALK-only at 12/4/8; `run_mode` in each `panini-ingest-enum` marker). A `panini-ingest` gap > 2.5 h is now a real gap (was 4 h). `panini-ingest-enum` rows with `extra ? 'stall'` are the runner's own hang/sleep reports — `ok=false` = it hung and exited; read `extra.stall.phase`.
- **The open Panini list with each read is the HANDOFF section at the end of `docs/strategy/panini-multi-product-2026-09-28.md`.** Two checks a pass can do: (1) product names from collectors' collections — `extra ? 'product_names'` rows after the ~5:45 AM PT collector walk; (2) **> 7 d must stay 0** (`panini_editions.last_seen_at`). Tier-2 admission is Trevor's call on the numbers there; do not admit from a night pass.
- **Do NOT re-flag:** `panini-collector-walk` `ok=false` "per-walk cap of 10 min reached" on large profiles (by design; `walkOrder` rotates the start collection); 242 of 246 packs reading "not modeled" (only 1038/1039/1055/1056 have a model).

## STEER — added 2026-10-04 ~8:45 PM PT (Claude Code cloud, trading/swap-test thread archived)

- **`/admin/swap-test` + `public.swap_test_relay` are an admin-only test awaiting Trevor's live run.** An EMPTY relay table is the expected state (0 rows at handoff, and rows delete themselves after 24 h). It is not an unused table. **Do NOT drop it, add readers to it, or "tidy" `lib/swap-test/`.** Handoff: `docs/strategy/trading-revisit-2026-10-03.md` §9.
- **Do NOT re-suggest user-facing trading, the Trade Hub escrow deploy, or a trade "matcher"**: each is Trevor's decision, and is held by roadmap §9.6 and the accuracy gate.

## STEER — added 2026-10-04 ~8:50 PM PT (Claude Code cloud, thread close)

- **Rewards/points are OFF on purpose** (`REWARDS_LIVE` unset → award/redeem refuse; shop/rules tagged paused). Zero point awards is the designed state, not a dead lane. Do not re-enable from a night pass.
- **Top Shot team Moments:** all 590 are `player_id` NULL, `player_name = team_name`, `name = "<team> — <set>"`. A row with `name = set_name` or a `players` row named after a team is a REGRESSION — read player-identity.md ("A TEAM Moment has no player").
- **Pack-identity backlog boost (job 705) is gone by design** (unscheduled itself when the queue emptied, evening 10-04); pack rips 0 disagreeing with the chain. Lane 704 keeps applying new identities.
- **FIXED 2026-10-09 (`20261009150802`), no longer a do-not-reflag:** `atlas-edition-supply` read 80 % failed because Cloudflare 403s 2–12 of each walk’s 38 pages. The drain now re-asks a transiently refused page (403/408/429/5xx/no response) up to 3 attempts; only a page out of attempts (or a bad 200 / other 4xx) fails the run. **A `failure_rate` row on this lane after 10-12 is REAL** — before then it pools pre-fix runs, so split at 8:08 AM PT 10-09 first.

## STEER — added 2026-10-04 ~10:45 PM PT (Claude Code, Trevor's box; save-to-collection + Panini freshness thread archived)

- **Panini `NO_DATA` rows in `panini_fmv_snapshots` are NEW and CORRECT** (`d730717d6`, deployed READY ~10:30 PM PT 10-04): a walked card with no sale ever and 0 listed now retires its old ask-based price instead of serving it. **Verify** (re-timed 11:50 PM PT 10-04): the branch fires on ~1 card in 360, and the first post-deploy walk had written 54 rows with 0 NO_DATA and 0 `fmv_error` by 11:49 PM. ✅ The first one landed at 11:57 PM PT (one of the 41, $10,000 ASK_ONLY → NO_DATA); the rest follow over the coming days. The 41 known editions were walked recently and come back round in the ~4–5-day stalest-first rotation. Done-check: `count(*) where confidence='NO_DATA'` > 0, and Query 6b's `old_older_7d_walked_24h` falls to ~0 by ~10-09. Falsifier: ≥ ~3,000 cards walked since the deploy with 0 NO_DATA (read `for_sale_count` on the latest payloads). **Do NOT "fix" null FMV rows that carry `NO_DATA`.** Falsifier: hundreds a day means the stats payload lost `for_sale_count`.
- **Panini freshness check: the repo prompt now mirrors the LIVE routine plus the 10-04 edits** (the repo copy had been stale since 09-27 while the live prompt was edited on 10-01). ✅ **The routine IS updated** (10-17 from a Cowork cloud session linked to the bound laptop; read back 2026-10-18 ~10:30 PM PT via `list_triggers`: the live prompt equals everything below the paste line of `docs/scheduled-tasks/panini-freshness-check.prompt.md`, 46,884 characters, byte-identical). ~~A content update is refused with a 403 even from this laptop's Claude Code, so Trevor pastes it from Claude Desktop.~~ Until then its `absurd_24h` fires on real six-figure sales (Yamal 1/1 $210k, Wembanyama Gold /10) and Escalation 5 calls the walked-but-not-repriced editions "STARVING". Do not re-flag either, and do not cap sale-backed FMV. The ONE genuinely absurd row (Dembélé Tiger Stripe /12, $500k ASK_ONLY off a $1M listing) is filed as a Trevor decision in the Panini handoff (item 5b). Do not cap it from a night pass.
- **Share-page "Save to my collection" is LIVE** (`b430828c1`). Its first real user from the 10-04 funnel watch (`1830d5fd…`) still had 0 `saved_wallets` at 10:15 PM PT. A save from them is the lift signal, not a bug.

## STEER — added 2026-10-11 ~7:55 AM PT (Claude Code, Trevor's box) — STOP CARRYING these three; all CLOSED 10-09

The 10-10 AND 10-11 night passes both carried these as open. They were closed on 10-09 (ledger `### 2026-10-09 · 🗄 APPLIED ×3`), and a 10-10 6:30 AM PT ledger heading already said so. **Re-verified live 10-11 ~7:50 AM PT:**
- **`chain-arrival-pack-pulls` "durable bound" (P1) — SHIPPED 10-09 (`20261009162222` + `20261009165544`).** The function has a 45 s check budget, 2,000-row chunks, a durable `chain_arrival_rebuild_queue` and a 75 s rebuild cutoff. jobid 637: 30/30 ticks succeeded, max 14 s. Backlog: unchecked done probes 0, queued wallets 0, while 539 probes finished in 24 h. ⚠ **`chain_history` max age is NOT this lane's freshness.** It only writes when a custodial Dapper delivery arrives, so a 0-row tick on an empty queue is correct. Re-open only on a failed jobid 637 tick or `unchecked > 0` that persists across 3 ticks.
- **`topshot-sellback-walk` nft_id-null (P2) — FIXED 10-09 (`20261009162520`).** An id-less page takes the retry path (closed as failed after 8 attempts) and no longer aborts the run (`v_noid` in `prosrc`).
- **`topshot-pack-supply-backfill` HTTP 530 (P3) — RETIRED 10-09: pg_cron jobid 15 `active=false`.** It has had no runs since 10-09 1:15 AM PT. The live `rpc-topshot-pack-supply-atlas` (jobid 691) covers steady state.
- Also 10-11: the `cursor_stalled` HIGH pages on `topshot_offers_history_backfill` and `topshot_missing_fill_offers_walk` were finished one-time walks (`done=true`). Bounded suppressions in `20261011144350`. Re-open only if either cursor MOVES (re-dispatch).
- **Run `npm run ops:ready-queue` before carrying any item forward.** It marks items a later ledger heading closed.

## STEER — added 2026-10-09 ~4:10 PM PT, updated ~5:30 PM PT at thread archive (Claude Code cloud; Trevor traveling until 10-10)

- **Night pass: label every "0 shipped".** The verdict line carries `idle: no-work | routed-to-claude-code | routed-to-trevor | blocked` and the oldest routed item's age. An item routed 3+ nights goes in the handoff's first line. 10-05 → 10-09 a P1 aged five nights under "GREEN, 0 shipped" (detail: `docs/reference/autonomous-tasks.md`, "Ready queue + idle labels").
- **The ready queue prints at every cloud session start** (hook) and by `npm run ops:ready-queue` anywhere else. Items a later ledger heading closed show `✓ likely closed (ledger.md:N)`. The rest is the open queue. ⚠ STALE means ≥ 3 nights. Verify each item against the ledger top before acting.
- ✅ Session-start hook prints the queue (approved 10-09 ~4:30 PM PT). **Still pending Trevor:** install the updated `rpc-nightly-autonomous-pass.skill` in Cowork and the cloud nightly trigger.

## STEER — added 2026-10-09 ~4:30 PM PT (Claude Code cloud; Trevor traveling 10-09 → 10-10)

- **Pick-up file: `docs/handoff-2026-10-09-claude-code-afternoon.md`** (shipped list, one HELD prod fix, watch list in date order).
- **`atlas-edition-supply` `failure_rate` (high) is a POOLED reading — do NOT re-fix.** The retry fix `20261009150802` landed 10-09 ~8 AM PT; every run since is `ok`. The arm pools 3 days, so it clears by itself ~10-12 5:18 AM PT. Re-open only on an `ok=false` run after 10-09 8:13 AM PT.
- **`pg_net_http_400` "height range 5000 exceeds maximum allowed of 250" at 10-09 2:22 PM PT was a one-off manual chain probe** (the daytime session's Golazos check), not a lane. Re-open only if it RECURS.
- **#175 holds a ready-to-run 3-sale re-key (Wembanyama Diced `152:5370`) that a night pass must NOT run on its own** — Trevor's go-ahead first (the handoff §2 has the block).

## ⏬ Older steers rolled to [focus-archive-2026-H2.md](focus-archive-2026-H2.md): 2026-09-14 and earlier on 2026-09-24; 2026-09-18 → 2026-09-20 on 2026-10-03. The persistent sections below (do-not-re-flag, inbox append-only, STANDING, sentinel queue, DECIDED, RETIRED STEERS) were kept.

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
