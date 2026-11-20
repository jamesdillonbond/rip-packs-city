# Daytime monitor — 2026-11-20 ~19:11Z (Cowork cloud, laptop-linked, READ-ONLY sweep)

Sweep baseline CLEAN: `rpc_ops_snapshot()` security 4/4 `[]` (invariants / anon_write_holes / rls_off_base / secdef_anon all empty), trust_health 41/41 `ok` (0 breaches), `detect_stalled_pipelines()` `[]`, sentinel TS-UUID editions 48h = 0, `cross_collection_mat_staleness` `[]`, client_error beacon 0/6h 0/24h, 13/13 live dashboards validate (67/67 relations + 7/7 functions exist), DB 55,457 MB (~normal growth off the 54.9 GB health-check baseline), last production deploy READY. **Positive control 0 IO-wait / 0 active — NOT a spell**, so the causal read below is interpretable, not a symptom to defer.

The snapshot `pipeline_alerts` are all the known upstream classes (Dapper Studio 530 #218, Atlas Cloudflare 403 base-rate, `pinnacle-wmc-render-id` medium aging out per focus 11-19) — none new, none HIGH.

---

## CANDIDATE 1 (HIGH) — `rpc-allday-ev-corrected-refresh` pg_cron job fails duplicate-key EVERY tick since 18:47Z; `mv_allday_pack_ev_corrected` frozen at the 12:47Z snapshot

- **Title:** `mv_allday_pack_ev_corrected` CONCURRENTLY refresh fails `duplicate key ... mv_allday_pack_ev_corrected_dist (dist_id)=(165)` because `pack_ev_latest` now returns 2 rows for 48 AllDay dists and the MV's `LEFT JOIN pack_ev_latest ON dist_id` fans out.
- **Source:** `check_pgcron_recent_failures()` → job `rpc-allday-ev-corrected-refresh`, latest run `2026-11-20 18:47:00Z` = failed; prior ticks 12:47 / 06:47 / 00:47 / 11-19 all `succeeded`. pg_cron job does a direct `REFRESH MATERIALIZED VIEW CONCURRENTLY` (per ledger 2026-07-12 `cron_heavy` entry, jobid 28, `MAINTAIN` on this MV).
- **Root cause (pinned, read-only):**
  - `pack_ev_latest` is `SELECT DISTINCT ON (h.pack_listing_id) …` — it is unique per **pack_listing_id**, NOT per `(dist_id, collection_id)`.
  - As of this sweep, **48 of 3,149 AllDay dists** have 2 `pack_ev_latest` rows for collection `dee28451-5d62-409e-a1ad-a83f763ac070` (dist 165 = 2 rows; also 120–145 run). This happens when one AllDay distribution now carries two distinct `pack_listing_id`s.
  - `mv_allday_pack_ev_corrected`'s final `calc` CTE does `… LEFT JOIN pack_ev_latest pel ON pel.dist_id = s.dist_id AND pel.collection_id = <AllDay>`. With 2 `pel` rows for a dist, the join emits 2 MV rows for that dist → the CONCURRENTLY rebuild of the unique index `mv_allday_pack_ev_corrected_dist` raises `duplicate key`.
  - 12:47Z succeeded because dist 165's 2nd listing appeared after it; `allday_pack_supply` itself has NO dup dist_id (ruled out), and the live MV currently holds the clean 12:47Z result (0 dup rows in the MV right now — it simply did not refresh).
- **Risk read:** This is a **deterministic logic defect that recurs every 6-hourly tick** (next 00:47Z will fail again) until either the dup `pack_listing_id`s clear or the join is deduped. Blast radius is bounded: `v_allday_pack_ev_corrected` (and the AllDay "corrected" pack-EV surface it backs) is **STALE, frozen at 12:47Z**, not wrong. Trust arm `pack_ev_board_max_stale_days` is still `ok` (0.026, breach_at 2) so it is not yet tripping — but the AllDay corrected board drifts further stale with each failed tick.
- **Suggested action (night pass / not for this read-only pass):** make the MV's `pack_ev_latest` leg pick exactly one row per `(dist_id, collection_id)` — e.g. replace the join with a `LEFT JOIN LATERAL (SELECT … FROM pack_ev_latest pel WHERE pel.dist_id = s.dist_id AND pel.collection_id = '<AllDay>' ORDER BY pel.snapshotted_at DESC LIMIT 1) pel ON true`, or a `DISTINCT ON (dist_id) … ORDER BY dist_id, snapshotted_at DESC` subquery. Additive to the MV definition, low-risk; follow the migration three-file + CONCURRENTLY-index discipline, then one manual `REFRESH … CONCURRENTLY` to un-freeze. (Alternatively, if the two `pack_listing_id`s per dist are themselves a data error upstream, dedup that — but the MV should be robust to it regardless.)
- **NOT a recent-ship regression:** none of the last-24h ships (get_top_movers `20261120161120`, schedule-fallback/privacy `aa76b6c`, Candy status re-verify `20261120144221`) touch AllDay pack-EV or `pack_ev_latest`; this is an emergent data condition (48 AllDay dists gained a 2nd pack listing).

## CANDIDATE 2 (LOW / info) — repo HEAD `f6616b8` has no READY production deployment

- **Title:** The two most-recent `main` commits (`b03a9d6`, `f6616b8` = HEAD) show Vercel state **CANCELED** (not ERROR); production serves `aa76b6c` (READY, rollback candidate).
- **Source:** `list_deployments` (project `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`), 2026-11-20.
- **Risk read:** **Zero user-facing impact.** Both canceled commits are docs/db-only (no frontend diff), and `f6616b8`'s DB change (`get_top_movers`, `20261120161120`) was applied directly to the DB and is already live. CANCELED ≠ ERROR, so this is not deploy breakage. Noted only because HEAD is not the live build and both canceled in a row (b03a9d6 superseded by f6616b8 is normal; f6616b8 canceling with nothing newer is mildly unusual — likely Vercel auto-cancel + rapid pushes).
- **Suggested action:** none required; the night pass's next `main` push will supersede this state with a fresh build. If it wants HEAD live before then, redeploy `f6616b8` from the Vercel dashboard. Confirm the next frontend commit builds READY.
