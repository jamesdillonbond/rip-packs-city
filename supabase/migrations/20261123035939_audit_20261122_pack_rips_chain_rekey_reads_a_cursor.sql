-- audit_20261122_pack_rips_chain_rekey_reads_a_cursor
-- anon-exec: unchanged (rekey_pack_rips_to_chain_identity) — CREATE OR REPLACE of an existing SECDEF fn; ACL preserved, has_function_privilege('anon') = false (read 2026-11-22).
--
-- 2026-11-22 ~8:00 PM PT (Claude Code cloud, autonomous pass). WHY. rekey_pack_rips_to_chain_identity() (pg_cron
-- job 704, `3,39 * * * *`) read every Top Shot identity checked in the LAST HOUR on each half-hourly run, so each
-- identity was probed twice. Its population grew (~9.5k Top Shot identities/h on 11-22 vs ~3.6k assumed at ship),
-- and each probe is a cold heap visit on pack_rips and pack_purchases: one leg measured 6.0 s, 9,191 of its
-- 9,502 probes disk reads. The job averaged 28.5 s/run (max 57.5 s) over 24 h, ~23 DB-minutes a day, and found
-- 3-19 rows a day (11-19..11-22). It was the root of minute 9's load in the fmv-recalc :08 collision (handoff
-- 2026-11-22 daytime, item 8; lever (2) "a 35-min lookback").
--
-- WHAT. The window is read from a one-row cursor, pack_rips_chain_rekey_cursor: (cursor - 5 min, now()]. The
-- 5 minutes cover an identity writer that committed after this run started with an earlier checked_at. No cursor
-- row (first run) = the old 1-hour window. The lower bound is clamped to 6 h, so a long pause cannot produce an
-- unbounded scan; extra.window_clamped says when that happened (identities in the gap wait for their next check,
-- the same loss the 1-hour window had). The cursor is written inside the run's own block: a failure rolls the
-- re-keys and the cursor back together and logs ok=false, so the next run re-reads the same window.
-- Expected: ~35 min of identities per run instead of 60, so ~40 % fewer probes. Rows re-keyed per day unchanged.
-- Pin: supabase/tests/rekey_pack_rips_to_chain_identity.sql (K1-K4 unchanged; K5 the cursor).
--
-- REVERT: re-apply the function block of 20261011083816_audit_20261011_rip_rekey_keeps_attribution_in_step.sql;
--   the cursor table can stay (unread) or be dropped.

CREATE TABLE IF NOT EXISTS public.pack_rips_chain_rekey_cursor (
  id int PRIMARY KEY CHECK (id = 1),
  checked_hi timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pack_rips_chain_rekey_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_rips_chain_rekey_cursor FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rekey_pack_rips_to_chain_identity()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_n int := 0;
  v_p int := 0;
  v_a int := 0;
  -- 2026-11-22: the identity window is read from a cursor (see the migration header). v_hi is the
  -- transaction start, so a row checked later is never inside this window; the next run starts 5 min
  -- before it to cover identity writers that committed late with an earlier checked_at.
  v_hi constant timestamptz := now();
  v_cursor timestamptz;
  v_lo timestamptz;
BEGIN
  SELECT c.checked_hi INTO v_cursor FROM public.pack_rips_chain_rekey_cursor c WHERE c.id = 1;
  v_lo := CASE WHEN v_cursor IS NULL THEN v_hi - interval '1 hour'
               ELSE greatest(v_cursor - interval '5 minutes', v_hi - interval '6 hours') END;

  WITH target AS (
    SELECT r.id, r.pack_nft_id, r.dist_id AS old_dist_id, i.dist_id AS new_dist_id
    FROM public.pack_nft_identity i
    JOIN public.pack_rips r ON r.pack_nft_id = i.pack_nft_id AND r.collection_id = i.collection_id
    WHERE i.checked_at > v_lo AND i.checked_at <= v_hi
      AND i.collection_id = v_ts
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND r.dist_id IS NOT NULL
      AND i.dist_id <> r.dist_id
      AND EXISTS (SELECT 1 FROM public.pack_distributions d
                   WHERE d.collection_id = i.collection_id AND d.dist_id = i.dist_id)
  ), saved AS (
    INSERT INTO public.audit_20261004_pack_rips_dist_rekey_backup (rip_id, pack_nft_id, old_dist_id, new_dist_id)
    SELECT id, pack_nft_id, old_dist_id, new_dist_id FROM target
    ON CONFLICT (rip_id) DO NOTHING
    RETURNING rip_id
  ), upd AS (
    UPDATE public.pack_rips r
       SET dist_id = t.new_dist_id
      FROM target t
     WHERE r.id = t.id
    RETURNING r.id
  )
  SELECT count(*) INTO v_n FROM upd;

  -- 2026-10-11: the attribution copy follows the rip (20261011084500). get_pack_realized_ev_row picks
  -- rips by attribution.dist_id alone, so a re-keyed rip left there kept counting under the old dist.
  -- Any attribution row of a rip whose identity (checked in the window) now equals its dist.
  WITH target AS (
    SELECT a.rip_id, a.dist_id AS old_dist_id, a.method, a.confidence, a.n_editions, r.dist_id AS new_dist_id
    FROM public.pack_nft_identity i
    JOIN public.pack_rips r ON r.pack_nft_id = i.pack_nft_id AND r.collection_id = i.collection_id
    JOIN public.topshot_pack_rip_attribution a ON a.rip_id = r.id
    WHERE i.checked_at > v_lo AND i.checked_at <= v_hi
      AND i.collection_id = v_ts
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND r.dist_id = i.dist_id
      AND a.dist_id IS DISTINCT FROM r.dist_id
  ), saved AS (
    INSERT INTO public.audit_20261011_rip_attribution_rekey_backup (rip_id, old_dist_id, old_method, old_confidence, old_n_editions, new_dist_id)
    SELECT rip_id, old_dist_id, method, confidence, n_editions, new_dist_id FROM target
    ON CONFLICT (rip_id) DO NOTHING
    RETURNING rip_id
  ), upd AS (
    UPDATE public.topshot_pack_rip_attribution a
       SET dist_id = t.new_dist_id, method = 'dapper_index', confidence = 'high', n_editions = NULL
      FROM target t
     WHERE a.rip_id = t.rip_id
    RETURNING a.rip_id
  )
  SELECT count(*) INTO v_a FROM upd;

  -- 2026-10-04: purchases too (20261004190000). Same chain-only rule, own backup table.
  WITH target AS (
    SELECT p.id, p.pack_nft_id, p.pack_dist_id AS old_dist_id, i.dist_id AS new_dist_id
    FROM public.pack_nft_identity i
    JOIN public.pack_purchases p ON p.pack_nft_id = i.pack_nft_id AND p.collection_id = i.collection_id
    WHERE i.checked_at > v_lo AND i.checked_at <= v_hi
      AND i.collection_id = v_ts
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND p.pack_dist_id IS NOT NULL
      AND i.dist_id <> p.pack_dist_id
      AND EXISTS (SELECT 1 FROM public.pack_distributions d
                   WHERE d.collection_id = i.collection_id AND d.dist_id = i.dist_id)
  ), saved AS (
    INSERT INTO public.audit_20261004_pack_purchases_dist_rekey_backup (purchase_id, pack_nft_id, old_dist_id, new_dist_id)
    SELECT id, pack_nft_id, old_dist_id, new_dist_id FROM target
    ON CONFLICT (purchase_id) DO NOTHING
    RETURNING purchase_id
  ), upd AS (
    UPDATE public.pack_purchases p
       SET pack_dist_id = t.new_dist_id
      FROM target t
     WHERE p.id = t.id
    RETURNING p.id
  )
  SELECT count(*) INTO v_p FROM upd;

  -- The cursor moves only with the run's work: a failure here raises, the handler below rolls the whole
  -- run back (re-keys and cursor together) and logs ok=false, and the next run re-reads the same window.
  INSERT INTO public.pack_rips_chain_rekey_cursor (id, checked_hi, updated_at) VALUES (1, v_hi, clock_timestamp())
  ON CONFLICT (id) DO UPDATE SET checked_hi = EXCLUDED.checked_hi, updated_at = EXCLUDED.updated_at;

  PERFORM public.log_pipeline_run('pack-rips-chain-rekey', v_started, v_n + v_p, v_n + v_p + v_a, 0, true, NULL,
    'nba_top_shot', v_cursor::text, v_hi::text, jsonb_build_object('rekeyed', v_n, 'purchases_rekeyed', v_p, 'attribution_synced', v_a,
      'window_lo', v_lo, 'window_hi', v_hi, 'window_clamped', v_cursor IS NOT NULL AND v_cursor - interval '5 minutes' < v_hi - interval '6 hours'));
  RETURN jsonb_build_object('ok', true, 'rekeyed', v_n, 'purchases_rekeyed', v_p, 'attribution_synced', v_a);
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- query_canceled named: a 57014 kill escapes WHEN OTHERS (R118). The tail is one
  -- log_pipeline_run insert, bounded even though the timer is not re-armed after a catch.
  PERFORM public.log_pipeline_run('pack-rips-chain-rekey', v_started, 0, 0, 0, false, SQLERRM,
    'nba_top_shot', NULL, NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;
