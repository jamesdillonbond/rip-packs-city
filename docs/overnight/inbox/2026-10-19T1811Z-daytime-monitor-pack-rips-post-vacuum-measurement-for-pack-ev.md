# pack_rips post-vacuum measurement (handed off by the 10-19 night pass) — record in pack-ev.md

**Filed by:** 🟢 Daytime health monitor, 2026-10-19 ~11:11 AM PT (18:11Z). Platform GREEN this sweep.

**Source:** 10-19 overnight handoff ("pack_rips post-vacuum read handed to the daytime monitor") + the 10-18 1:03 PM PT focus STEER (pg_cron 750 `maint-vacuum-pack-rips`, daily 4:37 AM PT). Read live via `pg_class` / `pg_stat_user_tables` and `EXPLAIN (ANALYZE, BUFFERS)` at ~18:06–18:08Z, after today's vacuum tick (`last_vacuum` 2026-10-19 11:37:34Z = 4:37 AM PT).

**Measurement (post-vacuum):**
- `pack_rips` visibility: **relallvisible 72.1% → 100.0%** (98,747 / 98,747 pages all-visible; relpages 98,747; total size 2,302 MB). Pre-vacuum baseline (night pass, 01:13 AM PT): 72.1% (71,190 / 98,747).
- `EXPLAIN (ANALYZE, BUFFERS) select * from v_allday_pack_lifecycle where dist_id = '6924'`: **285 ms / 901 heap fetches → 36.0 ms / 147 heap fetches** (focus baseline was 691 ms / 715 heap fetches on 10-18). Plan: Index Only Scan using `idx_pack_rips_dist_agg_v4` (rows=1887), Heap Fetches 147; Execution Time 36.0 ms, Planning 4.2 ms.

**Risk read:** none. Read-only measurement; the daily vacuum is behaving exactly as designed — the visibility map is now fully set, so the `v_allday_pack_lifecycle` GroupAggregate reads the index-only path with ~6x fewer heap fetches and ~8x faster than pre-vacuum.

**Suggested action (night pass / Trevor):** record both numbers in `docs/features/pack-ev.md` per the 10-18 focus STEER (the daytime monitor is read-only except this inbox write, so it cannot make that doc edit). No code or DB change. If future post-vacuum reads show allvisible NOT reaching ~100% or the dist-6924 read regressing above ~300 ms / ~900 heap fetches, that is the signal the daily vacuum has stopped keeping up — re-open then.
