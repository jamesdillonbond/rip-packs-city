# Overnight pass — 2026-10-23 (cloud nightly, Opus 4.8)

**Verdict: GREEN · 0 production shipped · idle: routed-to-trevor (concurrent Claude Code session active all night → queue-only posture) · oldest routed: #58 `OPENSEA_API_KEY` ~28 nights.**

> ⚠ **Environment scope:** push WAS available this run via the device-VM credential path (`store --file=…/.rpc-git-cred`, auth proven by `ls-remote` returning the live `main` SHA). The cloud sandbox cannot see the mount, and no `add_repo` tool exists in this session, so the cloud-direct push path is unavailable — but that is a fact about *this cloud session*, not the artifact. Trevor's machine and Claude Code push normally via Git Credential Manager; commit anything here as usual.

Run window ~01:04–01:25 AM PT (DB `now()` 08:04Z == shell clock, no skew; real local 01:04 AM PT, inside the 00:00–06:00 PT overnight window). Lock taken (`baf7e0166101`), FREEZE absent, normal mode. Previous lock was RELEASED (10-22 pass) and ~23.8 h old.

## Concurrency context (the reason 0 shipped)
A **12-hour autonomous Claude Code session** (Trevor, 10-22 ~10:09 PM PT: "work on roadmap and known issues … autonomously for the next 12 hours", runs to ~10 AM PT 10-23) pushed heavily tonight: player hubs, franchise hubs + Panini franchise panels (all 30 NBA), both rookie boards' 2026 class, platform-wide accent-blind search, the All Day custodial buyer-backfill fix, and the sitemap hub listing — newest commit `7f450af8c` at 00:53 AM PT. `origin/main` was `7f450af8c` on both fetches this run (run start and before this write). The entire user-facing surface + several migrations (`20261023073556/060839/053500/053026/052044/051104/050947`) are therefore HOT (real commits in the last ~3 h). Per Section 3, a surface a concurrent session is actively pushing is not mine to touch → queue-only posture. Nothing independently clean-safe + non-hot + verifiable was open regardless; see "Nothing to ship" below.

## Reviewed
- **Capability triage:** shell green (git 2.43, 31 G free); Supabase + Vercel MCP up; device bridge both arms alive (`device_list_dir` + `device_bash`). Push proven via device-VM cred. Cloud clone `$HOME/rpcwork` on `main` @ `7f450af8c`.
- **Inbox since last night pass (10-22 08:05Z):** one new filing, `2026-10-23T0310Z` (All Day buyer-backfill decode dead-zone) — **already drained by Claude Code** (custodial band refuted as a dead zone; fixed `cd292b289` + `0d909b885`, verified ok on the 11:15 PM run). No action; disposition noted here per the append-only rule (inbox untouched).
- **Carried queue** (from 10-22 handoff / `ops:ready-queue`): 3 items, all externally owned — re-listed below with night counts.

## Section 2 — health drift (all instruments, with the liars distrusted)
**GREEN.**
- **Security:** `rpc_ops_snapshot().security` all `[]` (invariants, anon_write_holes, rls_off_base_tables, secdef_anon_violations). Direct-catalog check not separately needed — snapshot arm is the same query.
- **Trust health:** 37/38 arms ok. Sole BREACH `candy_sales_stale_hours` **268.8 h** (breach 168) = known **#58** (Trevor-only OpenSea key; Magic Eden Candy feed silent since 10-11). Up from 244.7 h on 10-22 — grows by design while unkeyed. `trust_precompute_max_age_hours` 5.3 h ok (so the cluster is real readings, not a stale refresher). `edition_integrity_flags` 22 (breach 250). `unmapped_resolution_backlog_max` 18 (breach 100).
- **R118** `check_when_others_timeout_blind()` = **0**. `stalled_pipelines` `[]`. All catalog-drift arms `[]` (search_path, procedure pins, suppression drifts, backward_cursor_rewinds, wmc_null_edition_key, cross_collection_mat_staleness).
- **`check_zero_yield_lanes()` — 5 offenders (NEW vs 10-22; QUEUED for characterization, not shipped):** `resolve-topshot-stubs` + `topshot-stub-resolver` (last_find 10-13), `ufc-enrichment-drain` (last_find 10-15), `candy-sales-indexer` (last_find 10-12), `allday-unmapped-resolver-tail` (last_find 10-13). Read as drained backlogs, not stalls — `detect_stalled_pipelines()` `[]` and backlog_max 18 (low). `candy-sales-indexer` is #58 (nothing to index). `ufc-enrichment-drain` was **RETIRED 10-18** (cron-job.org disabled) yet still flags because it has no `pipeline_zero_yield_suppressions` row. See queued item 4. ⛔ No suppression shipped: (a) it needs the per-lane positive-control re-derivation the 10-17/10-18 passes did, not a reflex row; (b) a literal-value INSERT is MCP-held in a headless session anyway.
- **Pipeline alerts (6 rows):** 2 medium, both **stale pooling across a fix (R124)** — not live:
  - `allday-buyer-backfill` "6/18 failed (33.3%) … decode wall". Split at the fix (`0d292b289`/`0d909b885` deployed ~06:00Z 10-23): the first post-fix band run **06:15Z (11:15 PM PT) is `ok=true`** (custodial 480, decode_failed 0). The 6 failures are all pre-fix band re-walks; they age out of the 3-day window. No regression.
  - `panini-holder-concentration` "2/5 failed (40%) … statement timeout". Recovered since 10-21 15:09Z — last 3 runs (10-21 15:09, 15:14, 10-22 12:29) all ok. Pooling two 10-21 14:5x failures.
  - 4 info rows: Atlas editions/market/pack-supply upstream-403 + flow-rest moment-moved-400 — all attributed, self-healing, every lane fresh (last 200s 08:03–08:06Z); none escalated.
- **`pipeline_fails_24h`:** `topshot-pack-supply-atlas` 348 (chronic Cloudflare 403-retry, upstream 0, lane fresh), rest ≤18, all upstream 0.
- **Accuracy gate (R125, `fmv_sales_backtest` 7 d):** holds.
  - NBA Top Shot: published ALL err 16.0 % / ratio **0.952**; HIGH err 10.0 % / within25 81.2 % / ratio **0.958**. `last3_median_30d` ALL ratio 1.000.
  - NFL All Day: HIGH err 7.1 % / within25 84.2 % / ratio **1.000**; MEDIUM ratio 1.077. published ALL ratio **1.102** (just over 1.10) is dragged by the known degenerate buckets — `ASK_ONLY` ratio 2.700 (n=105, err 170 %) and `STALE` ratio 3.421 (n=19, err 242 %); both are internal-confidence tails on an ask-priced thin market (never rendered to users), and 93 % of All Day sales are sub-$1 (HIGH median_abs_err_usd $0.02). Core estimator in band; not a pipeline fault, not a ship. Watch only — ASK_ONLY n grew 68→105 and its ratio 1.800→2.700 vs 10-17.
- **Vercel 24 h runtime errors:** 5 groups, all known chronic — ipfs-media gateway race (2u), pack_realized_ev / exhausted_count / pack_lifecycle 5 s budgets (1u each), `get_player_top_sales` statement-timeout→degrades-to-empty (1u, first seen 07-27, pre-existing). **No new error class from any of tonight's new surfaces** (player/franchise hubs, Panini panels, rookie boards, search).
- **Client-error beacon 24 h:** 1 event, and it is a Claude Code positive-control probe (`/__probe`, `automated:true`) — 0 real user errors. (Sentry dark since 08-18 #34; Vercel groups near-zero beside it, so the "dark reporter" discriminator is satisfied.)
- **DB size** 41,469 MB (+132 vs 41,337 on 10-22). Normal growth (Panini +118 editions + sales + WAL). Large tier since 09-20.

## Post-ship watch — tonight's concurrent Claude Code ships: GREEN
- **All Day custodial buyer-backfill** (`0d909b885`): first post-fix band run (06:15Z) `ok=true`. Full exit is the **8:15 AM PT (15:15Z) run reporting `custodial_deposit` near 0** — re-check tomorrow. Falsifier: that run with `custodial_deposit` in the hundreds.
- **Player hubs / franchise hubs / Panini panels / rookie boards / accent search:** all verified live by Claude Code; independently, `public_board_empty_count` 0, `public_board_slow_count` 0, and no new Vercel error class. No regression.
- **Sitemap hub listing** (`20261023073556` + `7f450af8c`): exit is `/sitemap/3.xml` serving the hub URLs (CDN cache 6 h → readable after ~7:30 AM PT) and the `/players/` + `/teams/nba/` families appearing in Search Console ~10-30. Not verifiable this run; low-risk, reversible. Re-check tomorrow.

## Nothing to ship
Every open lever is either HOT (tonight's CC surface/migrations), externally owned (Trevor/interactive), or needs more than a reflex edit:
- the two medium pipeline alerts are CC-owned fixes already verified healthy (nothing to do);
- zero-yield characterization needs per-lane positive controls (queued);
- candy #58 is Trevor-only;
- the carried queue is all Trevor/interactive/Claude-Code.
A quiet, honest GREEN night.

## Queued for Trevor / Claude Code
1. **[P2, Trevor, ~28 nights] #58 `OPENSEA_API_KEY`.** `candy_sales_stale_hours` 268.8 h BREACH (was 244.7 h); Candy indexer healthy but has nothing to index — Magic Eden Candy feed silent since 10-11, OpenSea unkeyed. Clears when Trevor sets the key or the feed resumes. (Oldest routed → first-line per §6.)
2. **[P3, interactive/Claude Code, 2 nights] Demand re-read, PT week 10-15..10-21 — canonical doc write.** Read-only figures were gathered 10-22 (503 non-automated events / 120 sessions / 7 external signed-in; share→sign-in click still 0; referrers direct 218 / Google 93 / ChatGPT 40). NOT stamped: the 10-15 baseline queries were never codified (ref→source first-page classification + the headless-fingerprint discount can't be reproduced faithfully unattended; stamping a possibly-inconsistent block would seed a bad baseline). **Codify `scripts/demand-read.sql` from the 10-15 method first, then the write is mechanical.**
3. **[P3, Trevor/interactive] DROP 3 leftover scratch tables (~4.8 MB)** — `public.scratch_20261019_counter_checks_before`, `scratch_20261010_rip_dist_sample`, `scratch_20261010_rip_ident_batches`. RLS-on, no anon exposure; cosmetic; off-limits DROP for a night pass — SQL editor / interactive session.
4. **[P3, night-pass or interactive, NEW] Characterize the 5 zero-yield lanes; suppress/retire the drained ones.** `resolve-topshot-stubs`, `topshot-stub-resolver`, `ufc-enrichment-drain`, `candy-sales-indexer`, `allday-unmapped-resolver-tail`. Confirm each makes progress when work exists (positive control per lane, the 10-17/10-18 method) vs genuinely broken. `candy-sales-indexer` is #58 (no suppression — tied to the key). `ufc-enrichment-drain` is already retired (10-18) and should get a `pipeline_zero_yield_suppressions` row to stop it flagging. Read-only to characterize; a literal-INSERT suppression is MCP-held headless, so it wants an attended session or a migration DO-block.

## Carried watches (no decision needed)
- All Day custodial backfill 8:15 AM PT exit (above).
- Sitemap `/sitemap/3.xml` + Search Console exit (above).
- #193 Pinnacle re-measure due ≥10-31 (report numbers only; pricing change is not a night ship).
- Candy FMV MEDIUM steps down by design (exits ~11-02/11-09, ~0 % by ~11-11 while no Candy sale indexed).

## Failed / blocked / reverted
None. Nothing was applied, so nothing to revert. No production shipping was hard-stopped (none attempted).

---
*Instruments consulted: `rpc_ops_snapshot`, `check_when_others_timeout_blind`, `check_zero_yield_lanes`, `fmv_sales_backtest` (nba_top_shot, nfl_all_day), `pipeline_runs`, Vercel `get_runtime_errors` (24 h), `usage_events` client-error beacon. Lock released on exit.*
