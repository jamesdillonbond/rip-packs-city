-- anon-exec: unchanged — rekey_topshot_wmc_parallels is ALREADY revoked in prod, and this is
-- a CREATE OR REPLACE of a pre-existing function, which does NOT reset a function ACL.
-- Verified live 2026-09-14 (PT): anon=false, authenticated=false, postgres=true (pg_cron caller).
-- Live body re-read immediately before (md5 3e62ad3baa03f67e91214988a2cbde9d, len 3342); this
-- body stripped of the guard block re-hashes to that same md5 and length.
--
-- WHY. This is the SOURCE half of #82. `remap_misattributed_topshot_sales` was guarded earlier
-- today so it stops copying bad wmc keys into `sales`; this stops the bad keys being written.
-- Measured 2026-09-14 (PT): of 121,768 Top Shot wmc rows carrying a parallel key, 120,904
-- (99.29%) are supported by today's `topshot_moment_subeditions` evidence and 864 (0.71%) are
-- not -- 569 with no subedition row, 255 whose subedition is Standard (0), 40 disagreeing.
-- 643 of those 864 (74.4%) violate exactly this guard, and the null/<=0 escapes fired for NONE
-- of them (every row had a known circulation), so the guard is neither vacuous nor over-broad.
-- User impact of the adjudicable subset: 394 rows resolvable against the canonical
-- moments -> editions map, 383 genuinely wrong, net +$4,107.67 OVERSTATED FMV across 74 wallets
-- (abs $5,066.99, worst single row $1,170.00).
--
-- The lane is LIVE, not a frozen backlog: `audit_20260904_wmc_parallel_rekey` records 67,530
-- rekeys on 09-03 (initial backfill) then hundreds a day, spiking to 2,151 on 09-13.
--
-- STRICTLY SUBTRACTIVE: it can only REFUSE a rekey, never create one, so it cannot mis-key
-- anything on its own. It does NOT repair the existing 864 -- the inverse
-- (`remap_topshot_wmc_parallel_to_base_misattributed()`, which has ZERO callers) mutates wmc
-- plus its fmv columns and remains Trevor's call per #82.
--
-- REVERT: re-apply the body below with the PLAUSIBILITY GUARD block removed. Find by MESSAGE.
CREATE OR REPLACE FUNCTION public.rekey_topshot_wmc_parallels(p_scan integer DEFAULT 20000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_cursor text;
  v_next   text;
  v_scanned integer := 0;
  v_n integer := 0;
  v_ok boolean := true;
  v_err text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('rekey_topshot_wmc_parallels')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  INSERT INTO public.wmc_parallel_rekey_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT cursor_nft INTO v_cursor FROM public.wmc_parallel_rekey_state WHERE id = 1;
  BEGIN
    DROP TABLE IF EXISTS _rk_scan;
    CREATE TEMP TABLE _rk_scan ON COMMIT DROP AS
      SELECT sub.nft_id, sub.base_external_id, sub.subedition_id
        FROM public.topshot_moment_subeditions sub
       WHERE sub.nft_id > v_cursor
         AND coalesce(sub.subedition_id, 0) > 0        -- Standard rows have nothing to rekey
       ORDER BY sub.nft_id
       LIMIT GREATEST(p_scan, 1);
    SELECT count(*), max(nft_id) INTO v_scanned, v_next FROM _rk_scan;

    WITH cand AS (
      SELECT w.id, w.edition_key AS old_key, w.fmv_usd AS old_fmv, w.fmv_confidence AS old_conf,
             se.external_id AS new_key, l.fmv_usd AS new_fmv, l.confidence AS new_conf
        FROM _rk_scan sub
        JOIN public.wallet_moments_cache w
          ON w.moment_id = sub.nft_id
         AND w.collection_id = v_ts
         AND w.edition_key = sub.base_external_id
        JOIN public.editions se
          ON se.collection_id = v_ts
         AND se.external_id = sub.base_external_id || '::' || sub.subedition_id::text
        LEFT JOIN public.edition_fmv_current l ON l.edition_id = se.id
       WHERE coalesce(sub.subedition_id, 0) > 0
         -- PLAUSIBILITY GUARD (2026-09-14): never rekey a moment onto a parallel whose
         -- circulation cannot contain its serial. Measured that day: of 864 TS wmc rows
         -- carrying a parallel key unsupported by today's subedition evidence, 643 (74.4%)
         -- violate exactly this, and the null/<=0 escapes fired for NONE of them (every one
         -- had a known circulation). Strictly SUBTRACTIVE -- it can only REFUSE a rekey,
         -- never create one -- so it cannot mis-key anything on its own. Same guard shipped
         -- the same day into remap_misattributed_topshot_sales, which consumes this column
         -- and copied the bad keys into `sales` verbatim.
         AND (se.circulation_count IS NULL
              OR se.circulation_count <= 0
              OR coalesce(w.serial_number, 0) <= se.circulation_count)
    ),
    logged AS (
      INSERT INTO public.audit_20260904_wmc_parallel_rekey (wmc_id, old_key, new_key, old_fmv, old_conf)
      SELECT id, old_key, new_key, old_fmv, old_conf FROM cand
      ON CONFLICT (wmc_id) DO NOTHING
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET edition_key    = c.new_key,
             fmv_usd        = c.new_fmv,
             fmv_confidence = c.new_conf
        FROM cand c
       WHERE w.id = c.id
      RETURNING 1
    )
    SELECT count(*)::int INTO v_n FROM upd;

    -- Continuous: wrap to the start when the walk is exhausted.
    UPDATE public.wmc_parallel_rekey_state
       SET cursor_nft = CASE WHEN v_scanned > 0 THEN COALESCE(v_next, cursor_nft) ELSE '' END,
           updated_at = now()
     WHERE id = 1;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  -- Only a tick that did something writes a run row (an exhausted pass is a no-op, twice an hour).
  IF v_scanned > 0 OR NOT v_ok THEN
    PERFORM public.log_pipeline_run('wmc-parallel-rekey', v_started, v_scanned, v_n, 0, v_ok, v_err, 'nba_top_shot', v_cursor, v_next,
              jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int, 'scan', p_scan, 'via', 'pg_cron'));
  END IF;
  RETURN jsonb_build_object('scanned', v_scanned, 'rekeyed', v_n, 'cursor', v_next, 'ok', v_ok, 'error', v_err);
END
$function$;
