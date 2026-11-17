# Overnight pass — 2026-11-06 (~1:00–1:15 AM PT)

**Session:** Cowork cloud, laptop-VM clone + `.rpc-git-cred` (push available, dry-run `Everything up-to-date`). Genuine overnight run — clock verified against DB: shell 09:03Z, DB `now()` 09:04:30Z, newest sale ingest 09:03:11Z, newest FMV compute 08:53Z — all agree, no skew; 09:0xZ = ~1:0x AM PT, inside 00:00–06:00 PST. Not frozen.

**Verdict: GREEN · 0 production shipped · 0 reverted · 1 verified-benign item QUEUED (classifier-blocked config write).** One trust arm (`public_board_slow_count`) is in BREACH; independently verified benign (a grown-view cold-probe flicker, board healthy and fully populated). The one-row re-baseline that fixes the noise was **refused by this cloud session's auto-mode classifier ("Modify Shared Resources")** — the same refusal class the 11-05 daytime pass hit — so it is queued ready-to-run rather than routed around on an unattended run. Docs only: this handoff, ledger line, metrics, session entry.

## What was reviewed

- **CLAUDE.md** in full; continuity state (`ledger.md` top, `inbox/` both trees, `metrics-latest.json`, `focus.md`, latest handoffs 11-05 overnight + daytime).
- **Inbox — both fresh items already dispositioned by earlier 11-05/11-06 sessions (no re-ship):**
  - `2026-11-06T0109Z` `topshot_sold_floor_asks_found` "false positive" → **dispositioned NO CHANGE** by Claude Code local (ledger 11-05): NOT a false positive — a real seller-wave backlog (12–6 PM PT read 276/104/72/71); the 6:47 PM PT Cowork apply `20261106024733` (sold-floor clear reads `unmapped_sales`) fixed it, :55 reading now 0–2. Raising `breach_at` to 75–80 as filed would have hidden the defect that apply fixed. **Confirmed holding tonight: arm = 26, status ok.**
  - `2026-11-06T0414Z` `public_board_empty_count` BREACH on `topshot_perfect_mint_premiums_board` → **re-baselined 44 → 10** by Claude Code local (ledger 11-05; re-derived via an as-of recompute proving real premium compression, not an ingest break). **Confirmed holding tonight: `public_board_empty_count` = 0, status ok.**
  - Older items all dispositioned in prior handoffs; inbox left untouched (append-only; dispositions recorded here).
- **Dashboards:** none flagged broken by the monitor; no schema change broke a dashboard query. No repair in scope. (Artifact repairs not needed this run.)

## Post-ship regression watch (FIRST, before any shipping) — CLEAN

Re-measured the ships since the last overnight pass and their target metrics:

- **`20261106051049` `get_serial_backfill_targets` newest-first (Claude Code local 11-05 ~9:10 PM PT):** target = fresh TS NULL-serial rows resolve without waiting behind the 2023–25 tail. **Holding:** only **2** TS NULL-serial rows in the last 3 days (oldest 11-04 18:29Z, newest 11-06 08:33Z); the ~115-row 11-05 offer-fill seller wave is fully resolved. No revert.
- **`20261106024733` sold-floor clear reads `unmapped_sales` (Cowork 11-05 evening):** `topshot_sold_floor_asks_found` = 26 (<50), ok. Holding.
- **Perfect-mint liveness floor 44 → 10 (Claude Code local 11-05):** `public_board_empty_count` = 0, ok. Holding.
- **11-05 daytime/evening FMV ships (#213 All Day ≤50 premium-serial stale cap `20261105213600`; edition-detail capped survives bid floor `20261105063000`; All Day weekly accuracy job `20261105194500`; the 11-04 TS last-sale cap / `_bidfloor` / haircut-at-bid / All Day LOW 0.75 / #233 restatement):** no regression signal — `fmv_sanity_flags` 0, `edition_integrity_flags` 22 (<250), `topshot_fmv_stale_hours` 0.3, `panini_fmv_stale_hours` 0, `topshot_impossible_parallel_serials` 0, 0 FMV-related trust breaches. No new Vercel crash group. #228 collection-snapshot timeout absent from the 24h window. No auto-revert needed or taken.

## Health-drift findings + deltas (`rpc_ops_snapshot()` 09:06:46Z)

- **Security:** invariants `[]`, anon_write_holes `[]`, rls_off_base_tables `[]`, secdef_anon_violations `[]`. Clean.
- **Trust:** 39/40 ok, **1 BREACH: `public_board_slow_count` = 1** (see below). Notable ok legs: candy_sales_stale_hours 605.8 (<1114.9; re-verify candy_mlb ~11-27), edition_integrity_flags 22 (<250), panini_coverage_pct_drop 5.9 (<15), fmv_sanity_flags 0, trust_precompute_max_age 5.31 (<13), topshot_sold_floor_asks_found 26 (<50), public_board_empty_count 0 (<1).
- **Pipelines:** `stalled_pipelines` `[]`. `pipeline_fails_24h` all upstream 0 — topshot-pack-supply-atlas 13, atlas-pack-market 12, gha-schedule-watchdog 7, the rest ≤3 (all designed/small). Structural checks all `[]` (wmc_null_edition_key, backward_cursor_rewinds, function_search_path_drift, procedure pins/txn, cross_collection_mat_staleness, suppression drifts). sentinel_ts_uuid_editions_48h 0, ts_uuid_dupes_created_24h 0.
- **Alerts:** 2 `info`, both designed — moved-Moment hydration 400s (4.5%, last ok 09:03Z) and Atlas pack-supply 404 (1 of 240, last 200 09:06Z). None at escalation.
- **Sentry:** dark (SDK removed #34). **Client beacon:** 0 real errors in 7 d (only the positive-control probe).
- **Vercel:** last 5 production deploys all CANCELED = docs/migration-only commits superseded by `ignoreCommand` as designed (tip `cd7873c3e` is a migration file-record, no route code); prod still serves the last code READY. 24h runtime: 5 groups, all chronic (first-seen Jul–Sep — pack_realized_ev/get_pack_contents/pack_lifecycle >5000ms, set-activity + player-top-sales statement-timeout→degrade), all honest degrade-to-empty, no new crash group.
- **DB size:** 46,572 MB (+221 vs 46,351 last night) — within band; `net._http_response` 6h-TTL Atlas sawtooth. No new unexpected >200 MB public table.

### `public_board_slow_count` BREACH — verified benign (grown-view cold-probe flicker)

- **What tripped:** the 6-hourly board-liveness checkpoint at 06:28Z (:28 of 0/6/12/18 UTC) probed `v_insights_trophies` at **elapsed_ms 4,703 > max_ms 3,000**, `err` NULL, **row_count 2,687** (min_rows 206). So `public_board_slow_count` = 1 in the 09:06Z snapshot.
- **Not a dark surface / not a regression (independently measured):** `EXPLAIN (ANALYZE, BUFFERS)` warm execution = **1,104 ms** (planning 11 ms), normal plan (two seq scans of the ~62k-row `editions` table under an OR filter, `fmv_snapshots` partition lateral); the board renders 2,687 real rows. The 4,703 ms was a single cold/contended probe.
- **Root cause = threshold stale for a grown view.** The arm was calibrated 2026-08-01 at 827 rows / 85 ms with max_ms = 6× warm, floored at 3,000. The view has since grown to 2,687 rows (editions ~62k), so warm rose to ~1,104 ms and a cold probe now legitimately exceeds the 3,000 floor. This is exactly the cold/contended-flicker class the arm's own note was recalibrated once for, and the same noise class the daytime monitor flagged on the other two arms.
- **Queued fix (ready-to-run, one config row; this session's classifier refused it):**
  ```sql
  UPDATE public.public_board_liveness_watchlist
  SET max_ms = 7000,
      note = note || ' RE-BASELINED 2026-11-06 ~1:10 AM PT: max_ms 3000 -> 7000; view grew 827->2,687 rows, warm ~1,104ms (EXPLAIN ANALYZE), cold probe 4,703ms tripped the stale 3000 floor on a healthy board. 7000 = ~6x today''s warm (the arm''s own 6x multiplier re-applied), still far under the 25000 cap and the ~30s fail-soft danger threshold.'
  WHERE view_name = 'v_insights_trophies';
  ```
  Then run the precompute leg once so `v_rpc_trust_health` reflects it: `SELECT rpc_thp_leg_board_liveness();` and confirm `public_board_slow_count` = 0. No repo guard pins this board's max_ms (the sweep test uses synthetic fixtures), so no repo commit is needed — pure config DATA.
  **Revert:** `UPDATE public.public_board_liveness_watchlist SET max_ms = 3000 WHERE view_name='v_insights_trophies';` (the appended note sentence can stay).

### Deltas vs `metrics-latest.json` (11-05 daytime, 19:56Z)

- db 46,351 → 46,572 MB (+221), within band (net._http_response sawtooth).
- FMV HIGH+MED: nba 6,698 → 6,798 (+100); panini 17,972 → 17,998 (+26); nfl 1,644 → 1,646 (+2); pinnacle 932 → 937 (+5); candy 65 → 55 (−10, tiny collection, churn; candy_fmv_stale 2.3h ok); golazos 1 flat; ufc 0 flat. Normal churn (fmv_sanity_flags 0).
- editions: nba 14,688 → 14,696 (+8); panini 40,249 → 40,302 (+53); nfl/golazos/ufc/candy flat.
- trust breaches 0 → 1 (public_board_slow_count, benign).

## Owed dated reads

- **Panini old-catalogue backlog (focus.md steer, 11-06 read owed):** `panini_editions` older than 7 d = **12,368** (was 14,755 on 11-05 ~11:45 AM PT) ≈ **−2,387 in ~21.3 h ≈ −2.7k/day** — ahead of the expected −2.5k/day. Oldest `last_seen_at` 2026-10-26 07:17Z (was 10-25). Total editions 40,302. **On track.** 11-07 read still owed (backlog + the Panini walk-weighting-off regression watch: non-WC >9 d count falling, WC p50 ≤ ~4 d).

## Shipped

None (0 production). The one actionable item (trophies max_ms re-baseline) was classifier-refused and is queued above.

## Queued — needs a session/Trevor that can write shared DB resources

1. **`v_insights_trophies` max_ms 3000 → 7000** — NEW this pass; verified-benign noise fix, ready-to-run SQL + revert above. One config row. (This cloud session's auto-mode classifier refuses shared-resource writes; Trevor's machine / Claude Code apply normally.)
2. **#228 cold-whale `/api/collection-snapshot` timeout** — SQL lever exhausted; next lever CDN warm (route/edge, OFF-LIMITS). Not recurring (absent from 24h window). Trevor/Claude Code.
3. **#58 OPENSEA_API_KEY** (Trevor; candy re-verify ~11-27) — secret, no sandbox lever.
4. **net._http_response growth lever** (P4, Trevor; weekly read ~11-11) — whether `atlas_market_drain` should delete consumed 200 responses. High-water mark, not a leak.
5. **cron-job.org account has no MFA** (P3, Trevor) — from the 11-04 incident.

## Failed / blocked / reverted

- **Blocked (not an abort):** the `v_insights_trophies` max_ms re-baseline write was refused by this session's auto-mode classifier ("Modify Shared Resources"). Not routed around on an unattended run; queued above. No shipping hard-stop (nothing was shipped to stop).
- Nothing failed; nothing reverted.

## Revert (this pass)

Docs only — `git revert <this commit>`.
