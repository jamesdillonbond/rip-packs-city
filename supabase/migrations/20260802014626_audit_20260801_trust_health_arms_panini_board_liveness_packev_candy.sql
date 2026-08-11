-- audit_20260801_trust_health_arms_panini_board_liveness_packev_candy
--
-- Adds 6 arms to v_rpc_trust_health (25 -> 31), closing the coverage gaps the
-- platform grew past:
--   panini_fmv_stale_hours        (Panini had NO freshness arm and is now PUBLIC)
--   panini_coverage_pct_drop      (the number rendered in the public disclosure banner)
--   candy_fmv_pct_stale_30d       (parity: every other collection had a coverage leg)
--   pack_ev_publish_shortfall_pct (pack-EV COVERAGE was unmonitored)
--   public_board_empty_count      (no board-liveness signal existed at all)
--   public_board_slow_count       (the candy_holder_board failure was SLOWNESS)
--
-- Patched by GUARDED splice off pg_get_viewdef: the anchor must appear EXACTLY
-- once or the migration RAISES, so a whitespace drift aborts instead of silently
-- no-op'ing. CREATE OR REPLACE VIEW wipes reloptions, so security_invoker=on is
-- re-asserted below.
--
-- Revert:
--   Re-apply the pre-2026-08-01 definition (25 arms), i.e. run this same splice in
--   reverse -- delete the six ' UNION ALL SELECT ''panini_fmv_stale_hours''... '
--   through '...''public_board_slow_count''...' arms from pg_get_viewdef and
--   CREATE OR REPLACE, then re-assert:
--     ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
--   No data unwind: the view is read-only.
DO $mig$
DECLARE
  v_def     text;
  v_anchor  text := E'\n        )\n SELECT metric,';
  v_new     text;
  v_hits    integer;
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO v_def;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      'GUARD: expected the raw-CTE close anchor exactly once in v_rpc_trust_health, found %. Definition drifted -- aborting rather than silently no-op''ing.', v_hits;
  END IF;

  IF position('panini_fmv_stale_hours' IN v_def) > 0 THEN
    RAISE EXCEPTION 'GUARD: v_rpc_trust_health already carries panini_fmv_stale_hours -- refusing to double-splice.';
  END IF;

  v_new := $arms$
        UNION ALL
         SELECT 'panini_fmv_stale_hours'::text AS text,
            ( SELECT COALESCE(round(EXTRACT(epoch FROM now() - max(pfs.computed_at)) / 3600::numeric, 1), 999::numeric) AS "coalesce"
                   FROM panini_fmv_snapshots pfs) AS "coalesce",
            36::numeric AS "numeric",
            'ALL Panini FMV writers stalled -- the most fragile ingest lane on the platform (a residential Windows box on Task Scheduler that SLEEPS) feeding the PUBLIC /insights/panini-squeeze board, which had NO freshness arm at all until now. Measured over the full 1,927-batch history since 2026-07-16: the normal 4h-cadence gap is 3.7-4.0h (p99 3.70h, p50 0.02h within a walk), and the worst sleep EVER observed is 28.30h -- 2 gaps over 24h, ZERO over 30h. breach_at 36 sits ~8h above that all-time worst so an overnight or long-weekend sleep can never page, and is deliberately clear of the separate 09:00 PT panini-freshness-check scheduled task, which fires an hour before the box''s ~10:00 PT wake-up and self-heals. 36h = 9 consecutive 4h ticks missed: a dead runner, not a nap. INLINE (13.6ms) -- a precomputed freshness metric would carry up to 6h of its own staleness'::text AS text
        UNION ALL
         SELECT 'panini_coverage_pct_drop'::text AS text,
            ( SELECT GREATEST(0::numeric, 39.3::numeric - COALESCE(pcs.pct_trustworthy, 0::numeric)) AS "greatest"
                   FROM panini_coverage_summary pcs) AS "greatest",
            15::numeric AS "numeric",
            'the listing-gated COVERAGE figure collapsed. This number is rendered in the mandatory "treat this board as a floor, not a census" disclosure banner on the PUBLIC panini-squeeze surface and in meta.coverage of its public JSON, so a collapse puts a WRONG number in front of users -- a disclosure that understates its own gap is worse than no disclosure. Value = percentage points BELOW the 2026-08-01 calibration of 39.3% trustworthy (1,607 of 4,094 editions in broad-coverage families); reads 0 while coverage holds or improves. breach_at 15 comes from measured CHUNKINESS, not taste: coverage_flag is assigned per (set_name, parallel_family), so a whole family crosses the 10%-listed boundary at once -- Base Prizms Red (472 editions) and Base Prizms Blue (449) are 11.5pp and 11.0pp blocks currently sitting at 6.1% and 8.3% listed, so ONE ordinary listing tick can legitimately move the headline ~11pp. Anything under ~13 would page on market noise; 15 still catches both base families flipping (22.5pp) or a discovery-lane blowout. Re-base the 39.3 constant if coverage structurally improves -- an improvement can only make this read 0, never false-alarm. INLINE (17.4ms)'::text AS text
        UNION ALL
         SELECT 'candy_fmv_pct_stale_30d'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'candy_fmv_pct_stale_30d'::text), 999::numeric) AS "coalesce",
            25::numeric AS "numeric",
            'COVERAGE leg (baseline 0.0% on 2026-08-01): share of priced Candy editions whose LATEST FMV is >30d old -- the parity leg every other collection already had, complementing candy_fmv_stale_hours which reads only the freshest row and so stays green at 0.1h while a repricing backlog builds. Measured latest-FMV age across all 125 editions: p50 0.0h, p95 21.0h, max 42.1h, i.e. the entire catalogue reprices inside 2 days, so 25% (31 editions untouched for a month) can only mean a partial or selective writer stall. Threshold matches the AllDay and Pinnacle coverage legs. PRECOMPUTED (2026-08-01) at ZERO added cost: candy is a sixth lookup against the whole-table DISTINCT ON that legs 2-5 already compute -- see topshot_fmv_pct_stale_30d for the timeout-blindness rationale; a missing or >24h-old precompute row reports 999 and BREACHES'::text AS text
        UNION ALL
         SELECT 'pack_ev_publish_shortfall_pct'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'pack_ev_publish_shortfall_pct'::text), 999::numeric) AS "coalesce",
            10::numeric AS "numeric",
            'pack-EV COVERAGE silently regressing -- HOW MANY pack pages carry an EV at all, which pack_ev_board_max_stale_days (freshness) and pack_ev_board_pct_depleted (quality) both structurally miss: both read a board that is already published, so a filter that hides 60% of the catalogue leaves them perfectly green. Value = share of the pack universe (distinct pack_listing_id in pack_ev_history) that pack_ev_latest declines to publish. SELF-MEASURING against its own denominator, so unlike a pinned row count it cannot go stale as the catalogue grows. Baseline 0.76% on 2026-08-01 (35 of 4,631 excluded: 6 "Holding %" rows plus 45 with a known retail price but an unusable pack_price, overlapping); on the SAME DAY before the fix it read 60.8% (1,814 published) because a pack_price > 0 filter was discarding packs whose price was merely UNKNOWN. breach_at 10 is ~13x baseline -- far above any plausible move in the dynamic arms (the TopShot 3x-lowest-ask guard suppresses 0 today and has historically suppressed ~23) yet still 6x more sensitive than the failure that motivated it. An emptied pack_ev_history divides to NULL and reports 999, so a vanished table breaches instead of reading a comfortable 0. PRECOMPUTED: needs a DISTINCT over ~203k history rows'::text AS text
        UNION ALL
         SELECT 'public_board_empty_count'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'public_board_empty_count'::text), 999::numeric) AS "coalesce",
            1::numeric AS "numeric",
            'a PUBLIC /insights board rendering a blank empty-state while its data is fine. This is the class that hid candy_holder_board -- 373 collectors in the view, "Holders 0" on the live board, for DAYS, with zero Sentry and zero alerts -- because the view was slow and the page''s fail-soft caught the timeout and returned []. EVERY /insights board has that shape, so an outage is indistinguishable from an honest empty result and NOTHING watched for it. Counts active rows in public_board_liveness_watchlist whose count(*) fell below min_rows OR threw; an error counts as EMPTY because to the page both render the identical blank board. 45 boards watched, all 45 clean on 2026-08-01; min_rows is 25% of each board''s measured population (a collapse, not churn) and exactly 1 for single-row summary views. breach_at 1 because any single dark public board is a real defect, not a tolerance band. Two genuinely-can-be-empty market boards (candy_deals_board, topshot_underpriced_serials_board) are carried is_active=false WITH a stated reason rather than paging on honest market conditions. Adding a board is an INSERT, not a migration. PRECOMPUTED -- 43.8s warm across 47 views, ~40x this whole view''s budget, so it can never run on a sentinel read'::text AS text
        UNION ALL
         SELECT 'public_board_slow_count'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'public_board_slow_count'::text), 999::numeric) AS "coalesce",
            1::numeric AS "numeric",
            'a PUBLIC /insights board drifting toward the read-path wall, BEFORE it starts rendering empty. The candy_holder_board failure was SLOWNESS (82s against the request budget), not emptiness -- count(*) returned 373 the entire time -- so an emptiness-only check would have stayed green straight through it. Counts watchlisted boards whose warm probe exceeded their per-view max_ms, set at 3x measured-warm and CAPPED at 25000: the read path has ~30s, so a 3x budget above that could only fire AFTER the page had already failed, an arm that cannot warn in time. All 45 clean on 2026-08-01. TRUE FINDING carried by this arm from day one: topshot_perfect_mint_premiums_board runs 14.8s warm and topshot_pack_reality_dist 8.4s -- both public, both one contention spike from the same failure, both now capped at 25s so they warn before they break rather than after. PRECOMPUTED alongside public_board_empty_count'::text AS text$arms$;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS '
          || replace(v_def, v_anchor, v_new || v_anchor);
END
$mig$;

-- CREATE OR REPLACE VIEW wipes reloptions -- re-assert.
ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);