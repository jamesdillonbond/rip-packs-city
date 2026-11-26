-- audit_20261126_saved_wallet_stats_count_ufc_on_aptos
--
-- 2026-11-26 (Claude Code cloud; Trevor: "aggregate across the multiple chains/wallets" and, 11-22, "We
-- should have ufc" in the single Portfolio FMV). The saved-wallet cache (saved_wallets.cached_*), which
-- the dashboard Saved Wallets tiles, Portfolio FMV, public profile, share card and weekly email read, now
-- counts UFC Strike Moments held on Aptos accounts linked to the saved Flow address — the same population
-- the binder's value tile adds since 7306a24. Before: 4 of 58 saved UFC rows had linked Aptos holdings,
-- and a fully migrated collector's UFC tile read 0 Moments.
--   1. ufc_aptos_holds_any(flow, collection) — does this saved UFC row hold anything on Aptos?
--   2. aggregate_saved_wallet_stats — the per-wallet aggregate unions those Aptos Moments into the UFC
--      group, valued at edition_fmv_current like the binder (and with the same stale split).
--   3. reconcile_all_saved_wallet_stats — the hourly sweep no longer ZEROES such a row (it has no
--      wallet_moments_cache rows) and queues it; the oldest-age figures read the same population.
-- Revert: re-apply the previous bodies from 20260913233500 (reconcile) and the live 11-26 aggregate body
-- quoted in the ledger, then DROP FUNCTION public.ufc_aptos_holds_any(text, uuid).
--
-- anon-exec: revoked (ufc_aptos_holds_any) — new SECURITY DEFINER helper; REVOKE FROM PUBLIC, anon, authenticated below, GRANT to service_role.
-- anon-exec: unchanged (aggregate_saved_wallet_stats) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.

CREATE OR REPLACE FUNCTION public.ufc_aptos_holds_any(p_flow_address text, p_collection_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
     AND EXISTS (
       SELECT 1
         FROM public.ufc_aptos_wallet_links l
         JOIN public.ufc_aptos_holdings h ON h.aptos_address = l.aptos_address
        WHERE l.flow_address = lower(p_flow_address)
     )
$function$;

REVOKE ALL ON FUNCTION public.ufc_aptos_holds_any(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ufc_aptos_holds_any(text, uuid) TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.aggregate_saved_wallet_stats(p_user_id uuid, p_wallet_addr text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- AUTHZ: caller must be the user they claim to be (service_role bypasses)
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  WITH items AS (
    SELECT wmc.collection_id, wmc.fmv_usd, wmc.tier, efc.confidence,
           efc.edition_id AS efc_edition_id, efc.fmv_usd AS efc_fmv_usd
      FROM public.wallet_moments_cache wmc
      LEFT JOIN public.editions e
        ON e.external_id = wmc.edition_key
       AND e.collection_id = wmc.collection_id
      LEFT JOIN public.edition_fmv_current efc
        ON efc.edition_id = e.id
     WHERE wmc.wallet_address = p_wallet_addr
    UNION ALL
    -- 2026-11-26: UFC Strike Moments on Aptos accounts linked to this Flow address, valued
    -- at the edition's current FMV exactly as the binder's value tile values them.
    SELECT e.collection_id, efc.fmv_usd, e.tier, efc.confidence,
           efc.edition_id, efc.fmv_usd
      FROM public.get_ufc_aptos_holdings_for_flow(p_wallet_addr) h
      JOIN public.editions e ON e.id = h.edition_id
      LEFT JOIN public.edition_fmv_current efc ON efc.edition_id = h.edition_id
  ),
  agg AS (
    SELECT
      i.collection_id,
      COUNT(*) AS moment_count,
      COALESCE(SUM(i.fmv_usd), 0) AS fmv_sum,
      -- Stale split (2026-09-02): latest confidence per edition from edition_fmv_current.
      -- 2026-11-10: a WITHDRAWN price (current row, NULL price) still cached is stale too.
      COALESCE(SUM(i.fmv_usd) FILTER (WHERE i.confidence = 'STALE' OR (i.efc_edition_id IS NOT NULL AND i.efc_fmv_usd IS NULL AND i.fmv_usd IS NOT NULL)), 0) AS fmv_stale_sum,
      COUNT(*) FILTER (WHERE i.confidence = 'STALE' OR (i.efc_edition_id IS NOT NULL AND i.efc_fmv_usd IS NULL AND i.fmv_usd IS NOT NULL)) AS stale_count,
      (array_agg(UPPER(i.tier) ORDER BY
        CASE UPPER(i.tier)
          WHEN 'ULTIMATE'  THEN 1
          WHEN 'LEGENDARY' THEN 2
          WHEN 'RARE'      THEN 3
          WHEN 'FANDOM'    THEN 4
          WHEN 'COMMON'    THEN 5
          ELSE 6
        END, UPPER(i.tier))
       FILTER (WHERE i.tier IS NOT NULL))[1] AS top_tier
    FROM items i
    GROUP BY i.collection_id
  )
  UPDATE public.saved_wallets sw
  SET
    cached_moment_count  = agg.moment_count,
    cached_fmv_usd       = CASE WHEN agg.fmv_sum > 0 THEN agg.fmv_sum ELSE NULL END,
    cached_fmv_stale_usd = CASE WHEN agg.fmv_stale_sum > 0 THEN agg.fmv_stale_sum ELSE NULL END,
    cached_stale_count   = agg.stale_count,
    cached_top_tier      = agg.top_tier,
    cache_updated_at     = NOW()
  FROM agg
  WHERE sw.user_id       = p_user_id
    AND sw.wallet_addr   = p_wallet_addr
    AND sw.collection_id = agg.collection_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;

CREATE OR REPLACE PROCEDURE public.reconcile_all_saved_wallet_stats(IN p_max_seconds integer DEFAULT 50, IN p_max_wallets integer DEFAULT 500, IN p_min_age_minutes integer DEFAULT 360, IN p_max_moments integer DEFAULT 20000)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_started      timestamptz := clock_timestamp();
  v_deadline     timestamptz := clock_timestamp() + make_interval(secs => GREATEST(p_max_seconds, 1));
  v_pairs        jsonb;
  v_total        integer := 0;
  v_wallets      integer := 0;
  v_refreshed    integer := 0;
  v_zeroed       integer := 0;
  v_skipped_big  integer := 0;
  v_truncated    boolean := false;
  v_oldest_h     numeric;
  v_oldest_big_h numeric;
  i              integer;
BEGIN
  UPDATE public.saved_wallets sw
     SET cached_moment_count = 0,
         cached_fmv_usd      = NULL,
         cached_top_tier     = NULL,
         cache_updated_at    = NOW()
   WHERE sw.wallet_addr IS NOT NULL
     AND (sw.cached_moment_count IS DISTINCT FROM 0
          OR sw.cached_fmv_usd IS NOT NULL
          OR sw.cached_top_tier IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1
         FROM public.wallet_moments_cache w
        WHERE w.wallet_address = sw.wallet_addr
          AND w.collection_id  = sw.collection_id
     )
     -- 2026-11-26: a UFC Strike row whose Moments are all on linked Aptos accounts holds
     -- something too (aggregate_saved_wallet_stats counts them); never zero it.
     AND NOT public.ufc_aptos_holds_any(sw.wallet_addr, sw.collection_id);
  GET DIAGNOSTICS v_zeroed = ROW_COUNT;
  COMMIT;

  -- ⚠ WALLETS ABOVE p_max_moments ARE NOT IN THIS QUEUE (2026-09-13). One wallet
  -- with 44.6k moments cannot be aggregated inside the CALL's 120 s budget, and
  -- stalest-first put it at the head every hour, so the CALL died there before
  -- touching anyone else. They are counted below and logged, never silently
  -- dropped. A never-refreshed wallet (count NULL -> 0) is still attempted once.
  SELECT COALESCE(
           jsonb_agg(jsonb_build_object('u', s.user_id, 'w', s.wallet_addr)
                     ORDER BY s.stalest ASC NULLS FIRST),
           '[]'::jsonb)
    INTO v_pairs
    FROM (
      SELECT sw.user_id, sw.wallet_addr, MIN(sw.cache_updated_at) AS stalest
        FROM public.saved_wallets sw
       WHERE sw.wallet_addr IS NOT NULL
         AND sw.user_id IS NOT NULL
         AND (EXISTS (
           SELECT 1
             FROM public.wallet_moments_cache w
            WHERE w.wallet_address = sw.wallet_addr
              AND w.collection_id  = sw.collection_id
         ) OR public.ufc_aptos_holds_any(sw.wallet_addr, sw.collection_id))
       GROUP BY sw.user_id, sw.wallet_addr
      HAVING (MIN(sw.cache_updated_at) IS NULL
              OR MIN(sw.cache_updated_at) < now() - make_interval(mins => GREATEST(p_min_age_minutes, 0)))
         AND COALESCE(SUM(sw.cached_moment_count), 0) <= GREATEST(p_max_moments, 0)
    ) s;

  -- The wallets the gate above kept OUT, so the run can say so. Same population
  -- and staleness test as the queue, with the size test inverted.
  SELECT count(*)
    INTO v_skipped_big
    FROM (
      SELECT sw.user_id, sw.wallet_addr
        FROM public.saved_wallets sw
       WHERE sw.wallet_addr IS NOT NULL
         AND sw.user_id IS NOT NULL
         AND (EXISTS (
           SELECT 1
             FROM public.wallet_moments_cache w
            WHERE w.wallet_address = sw.wallet_addr
              AND w.collection_id  = sw.collection_id
         ) OR public.ufc_aptos_holds_any(sw.wallet_addr, sw.collection_id))
       GROUP BY sw.user_id, sw.wallet_addr
      HAVING (MIN(sw.cache_updated_at) IS NULL
              OR MIN(sw.cache_updated_at) < now() - make_interval(mins => GREATEST(p_min_age_minutes, 0)))
         AND COALESCE(SUM(sw.cached_moment_count), 0) > GREATEST(p_max_moments, 0)
    ) b;

  v_total := jsonb_array_length(v_pairs);

  FOR i IN 0 .. v_total - 1 LOOP
    IF clock_timestamp() >= v_deadline OR v_wallets >= p_max_wallets THEN
      v_truncated := true;
      EXIT;
    END IF;

    v_refreshed := v_refreshed + COALESCE(
      public.aggregate_saved_wallet_stats(
        (v_pairs -> i ->> 'u')::uuid,
        (v_pairs -> i ->> 'w')
      ), 0);
    v_wallets := v_wallets + 1;

    COMMIT;
  END LOOP;

  -- ⚠ SCOPED TO THE QUEUE'S OWN POPULATION (2026-08-28). This used to read every
  -- saved_wallets row, while the queue below reads only rows that HAVE wmc rows.
  -- MIN(cache_updated_at) was therefore pinned forever by 21 rows the sweep
  -- CANNOT touch by design -- the 2026-08-09 explicit zero-pass, all with
  -- cached_moment_count = 0 and zero wmc rows, deliberately excluded by the
  -- EXISTS clause. The figure rose +1.0/hour indefinitely and could never fall:
  -- 308 h on 08-21, 442.9 h on 08-27, +1.00/hour to two decimals.
  --
  -- ⚠ THE CONSEQUENCE THAT MATTERS IS THE INVERSE ONE: a genuine starvation --
  -- a QUEUED wallet going unreconciled for days -- was INVISIBLE, because the
  -- number was already pinned and climbing from an unrelated cause. It could not
  -- move in response to the thing it is named for. It also misled two separate
  -- readers into near-filing a user-facing alarm.
  --
  -- Measured with this predicate on 2026-08-27: oldest ELIGIBLE staleness 15.1 h
  -- (avg 10.0 h, zero over 7 days) against a reported 442.9 h -- so the metric
  -- overstated by ~29x and the sweep is very nearly keeping up. Both halves
  -- matter: "the metric is broken" and "the sweep is behind" need opposite
  -- responses.
  --
  -- The EXISTS is copied VERBATIM from v_pairs, including its position relative
  -- to the aggregate. Re-deriving it as bool_or() at the wallet level instead of
  -- EXISTS at the row level mixes the frozen rows back in and inverts the answer
  -- -- that is a different population, and the difference is invisible in the
  -- output because both produce a tidy per-wallet age.
  --
  -- ⚠ AND SINCE 2026-09-13 IT EXCLUDES THE ROWS THE SIZE GATE SKIPS, for the same
  -- reason: a wallet the sweep will never attempt would pin this figure forever
  -- and hide a starving QUEUED wallet behind it. The skipped population gets its
  -- own figure below (oldest_big_cache_h). ⚠ The first version (2:00 PM PT) tested
  -- the ROW's count here against the PAIR's sum in the queue and called the gap a
  -- "bounded, stated approximation"; it bit the same afternoon: the whale's OWN
  -- 4,580-row All Day row (and its 25/32/61-row ones) passed the per-row test,
  -- so at the 3:44 PM tick -- every queued wallet just refreshed -- oldest_cache_h
  -- still read 17 h and the Portfolio Cache Drain arm warned on a wallet the
  -- sweep will never attempt. Since 4:3x PM the test is the QUEUE's test: the
  -- pair's sum, so the two populations are the same population.
  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(sw.cache_updated_at))) / 3600.0, 1)
    INTO v_oldest_h
    FROM public.saved_wallets sw
   WHERE sw.wallet_addr IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.saved_wallets b
        WHERE b.user_id = sw.user_id
          AND b.wallet_addr = sw.wallet_addr
        GROUP BY b.user_id, b.wallet_addr
       HAVING COALESCE(SUM(b.cached_moment_count), 0) > GREATEST(p_max_moments, 0)
     )
     AND (EXISTS (
       SELECT 1
         FROM public.wallet_moments_cache w
        WHERE w.wallet_address = sw.wallet_addr
          AND w.collection_id  = sw.collection_id
     ) OR public.ufc_aptos_holds_any(sw.wallet_addr, sw.collection_id));

  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(sw.cache_updated_at))) / 3600.0, 1)
    INTO v_oldest_big_h
    FROM public.saved_wallets sw
   WHERE sw.wallet_addr IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.saved_wallets b
        WHERE b.user_id = sw.user_id
          AND b.wallet_addr = sw.wallet_addr
        GROUP BY b.user_id, b.wallet_addr
       HAVING COALESCE(SUM(b.cached_moment_count), 0) > GREATEST(p_max_moments, 0)
     )
     AND (EXISTS (
       SELECT 1
         FROM public.wallet_moments_cache w
        WHERE w.wallet_address = sw.wallet_addr
          AND w.collection_id  = sw.collection_id
     ) OR public.ufc_aptos_holds_any(sw.wallet_addr, sw.collection_id));

  -- ⚠ The 3-arg log_pipeline_run(text, boolean, jsonb) overload passes
  -- `p_started_at := now()`. now() is TRANSACTION START, and this procedure COMMITs
  -- per wallet, so by the time it logs, now() is the start of the tiny post-COMMIT
  -- transaction -- NOT the start of the sweep. duration_ms is a GENERATED column
  -- (finished_at - started_at), so it recorded the few ms since the last COMMIT.
  -- Measured 2026-08-26: avg elapsed 27,370 ms recorded as 10 ms, worst 114,748 ms
  -- recorded as 37 ms -- understated 2,688x. The named-arg form below passes the
  -- real v_started (clock_timestamp() at procedure entry).
  -- ⚠ p_rows_skipped is REAL since 2026-09-13 (the size-gated wallets); before
  -- that it was a key this caller never set (= 0). Every other value is what the
  -- 3-arg overload derived: p_rows_found from extra->>'fetched' (= v_total),
  -- p_rows_written from extra->>'upserted' (= v_refreshed), p_error from
  -- extra->>'error'. The extra jsonb gains three keys and changes no existing one.
  -- ⛔ Do NOT "fix" this in the 3-arg overload itself -- 14 other callers use it and
  -- they are all non-COMMITting FUNCTIONS, where now() IS their true start.
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'reconcile-saved-wallet-stats',
    p_started_at   := v_started,
    p_rows_found   := v_total,
    p_rows_written := v_refreshed,
    p_rows_skipped := v_skipped_big,
    p_ok           := NOT v_truncated,
    p_error        := CASE WHEN v_truncated
                           THEN 'soft_deadline_reached_partial_sweep_committed'
                           ELSE NULL END,
    p_extra        := jsonb_build_object(
      'wallets_done',        v_wallets,
      'wallets_total',       v_total,
      'wallets_skipped_big', v_skipped_big,
      'max_moments',         p_max_moments,
      'fetched',             v_total,
      'truncated',           v_truncated,
      'upserted',            v_refreshed,
      'rows_zeroed',         v_zeroed,
      'oldest_cache_h',      v_oldest_h,
      'oldest_big_cache_h',  v_oldest_big_h,
      'min_age_minutes',     p_min_age_minutes,
      'elapsed_ms',          ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_started)) * 1000),
      'error',               CASE WHEN v_truncated
                                  THEN 'soft_deadline_reached_partial_sweep_committed'
                                  ELSE NULL END
    )
  );
  COMMIT;
END;
$procedure$;
