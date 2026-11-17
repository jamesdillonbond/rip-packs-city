-- 2026-11-02 (#226) — a second, chain-sourced reconcile for the Top Shot moment -> edition map.
--
-- The Atlas lane (20261102182222) repoints a moment only when Dapper's marketplace index has SEEN it
-- (279,710 moments; Atlas-vs-chain 141/141). Moments that never traded there stayed blind. The chain's
-- own MomentMinted records (checkpoint_nft_meta, c='ts') are holder-independent and complete for every
-- minted moment — the 10-03 mint walk stopped at block 152,500,000 (~May 2026) and resumed 11-02 as the
-- daily mint-event-walk-forward workflow. trg_topshot_subedition_base_from_checkpoint already forces a
-- map row's base on INSERT / base UPDATE; this lane repairs rows written BEFORE their mint record landed,
-- and every table that copied the wrong base (wmc, sales, moments, id map).
--
-- First read (11-02 ~6:20 PM PT, 1,470 newly walked moments): 1,463 agree, 7 disagree — all 7 an
-- unresolved UUID-pair base for Mikal Bridges 245:8609 (no editions row exists for the UUID key).
--
-- What this does:
--   · topshot_atlas_reconcile_log gains `source` ('atlas' | 'checkpoint'); old rows read 'atlas'.
--   · _apply_topshot_reconcile_run(run_id): the repoint block, moved VERBATIM out of
--     reconcile_topshot_map_with_atlas so both lanes write the five tables the same way.
--   · reconcile_topshot_map_with_atlas: same candidates, now calls the helper (behaviour unchanged).
--   · reconcile_topshot_map_with_checkpoint(p_slice, p_max): walks checkpoint ts records behind a
--     cursor (a bounded nft-id slice per run, wraps to the start when it passes the newest record, so a
--     late-landing record is caught on the next sweep). A candidate needs: every spork record agreeing
--     (topshot_checkpoint_base), a chain-read subedition on the map row, and the target edition
--     existing. If p_max candidates are found the cursor does NOT advance (the rest of the slice is
--     next run's).
--   · pg_cron rpc-topshot-map-checkpoint-reconcile every 2 h at :57; watchlist 300 min.
--
-- Revert: SELECT cron.unschedule('rpc-topshot-map-checkpoint-reconcile');
--   DROP FUNCTION public.reconcile_topshot_map_with_checkpoint(bigint, integer);
--   re-apply reconcile_topshot_map_with_atlas from 20261102182222 (inline block), then
--   DROP FUNCTION public._apply_topshot_reconcile_run(uuid); DROP TABLE public.topshot_checkpoint_reconcile_cursor;
--   per-row data revert: topshot_atlas_reconcile_log (to_base -> from_base) for source = 'checkpoint'.

ALTER TABLE public.topshot_atlas_reconcile_log ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'atlas';

CREATE TABLE IF NOT EXISTS public.topshot_checkpoint_reconcile_cursor (
  id       integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_nft bigint  NOT NULL,
  sweeps   integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.topshot_checkpoint_reconcile_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_checkpoint_reconcile_cursor FROM PUBLIC, anon, authenticated;
-- Start at the first moment past the 10-03 walk's coverage.
INSERT INTO public.topshot_checkpoint_reconcile_cursor (id, next_nft) VALUES (1, 52038407) ON CONFLICT (id) DO NOTHING;

-- ── Shared repoint block ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._apply_topshot_reconcile_run(p_run uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  ts       constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sub int := 0; v_wmc int := 0; v_sales int := 0; v_mom int := 0; v_idm int := 0;
BEGIN
  UPDATE public.topshot_moment_subeditions t SET base_external_id = l.to_base
    FROM public.topshot_atlas_reconcile_log l WHERE l.run_id = p_run AND l.nft_id = t.nft_id;
  GET DIAGNOSTICS v_sub = ROW_COUNT;

  WITH u AS (
    UPDATE public.wallet_moments_cache w SET edition_key = l.to_key
      FROM public.topshot_atlas_reconcile_log l
     WHERE l.run_id = p_run AND w.collection_id = ts AND w.moment_id = l.nft_id AND w.edition_key <> l.to_key
    RETURNING w.moment_id)
  UPDATE public.topshot_atlas_reconcile_log l SET wmc_rows = x.n
    FROM (SELECT moment_id, count(*) n FROM u GROUP BY 1) x WHERE l.run_id = p_run AND l.nft_id = x.moment_id;

  WITH u AS (
    UPDATE public.sales s SET edition_id = tg.id
      FROM public.topshot_atlas_reconcile_log l, public.editions tg
     WHERE l.run_id = p_run AND s.collection_id = ts AND s.nft_id = l.nft_id
       AND tg.collection_id = ts AND tg.external_id = l.to_key AND s.edition_id <> tg.id
    RETURNING s.nft_id)
  UPDATE public.topshot_atlas_reconcile_log l SET sales_rows = x.n
    FROM (SELECT nft_id, count(*) n FROM u GROUP BY 1) x WHERE l.run_id = p_run AND l.nft_id = x.nft_id;

  WITH u AS (
    UPDATE public.moments m SET edition_id = tg.id, updated_at = now()
      FROM public.topshot_atlas_reconcile_log l, public.editions tg
     WHERE l.run_id = p_run AND m.collection_id = ts AND m.nft_id = l.nft_id
       AND tg.collection_id = ts AND tg.external_id = l.to_key AND m.edition_id <> tg.id
       AND NOT EXISTS (SELECT 1 FROM public.moments o WHERE o.edition_id = tg.id
                          AND o.serial_number = m.serial_number AND o.nft_id <> m.nft_id)
    RETURNING m.nft_id)
  UPDATE public.topshot_atlas_reconcile_log l SET moment_rows = x.n
    FROM (SELECT nft_id, count(*) n FROM u GROUP BY 1) x WHERE l.run_id = p_run AND l.nft_id = x.nft_id;

  WITH u AS (
    UPDATE public.topshot_moment_id_editions i SET edition_external_id = l.to_key
      FROM public.topshot_atlas_reconcile_log l
     WHERE l.run_id = p_run AND l.nft_id ~ '^[0-9]{1,18}$' AND i.id = l.nft_id::bigint AND i.edition_external_id <> l.to_key
    RETURNING i.id::text AS nft_id)
  UPDATE public.topshot_atlas_reconcile_log l SET idmap_rows = 1
    FROM u WHERE l.run_id = p_run AND l.nft_id = u.nft_id;

  SELECT COALESCE(sum(wmc_rows),0), COALESCE(sum(sales_rows),0), COALESCE(sum(moment_rows),0), COALESCE(sum(idmap_rows),0)
    INTO v_wmc, v_sales, v_mom, v_idm
    FROM public.topshot_atlas_reconcile_log WHERE run_id = p_run;

  RETURN jsonb_build_object('map_rows', v_sub, 'wmc_rows', v_wmc, 'sales_rows', v_sales,
                            'moment_rows', v_mom, 'idmap_rows', v_idm);
END;
$function$;

-- ── Atlas lane: same candidates, repoint through the helper ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reconcile_topshot_map_with_atlas(p_max integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  ts       constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_run    uuid := gen_random_uuid();
  v_start  timestamptz := clock_timestamp();
  v_cand   int := 0; v_sub int := 0; v_wmc int := 0; v_sales int := 0; v_mom int := 0; v_idm int := 0;
  v_res    jsonb;
  v_err    text;
BEGIN
  BEGIN
    INSERT INTO public.topshot_atlas_reconcile_log (run_id, nft_id, from_base, to_base, subedition, to_key, source)
    SELECT v_run, c.nft_id, c.old_base, c.new_base, c.sub,
           c.new_base || CASE WHEN c.sub > 0 THEN '::' || c.sub ELSE '' END, 'atlas'
      FROM (
        SELECT t.nft_id, t.base_external_id AS old_base, COALESCE(t.subedition_id, 0) AS sub,
               ev.s::text || ':' || ev.p::text AS new_base
          FROM (SELECT nft_id, min(set_id_onchain) AS s, min(play_id_onchain) AS p, bool_and(parallel = 'Standard') AS std
                  FROM public.topshot_atlas_market_events
                 WHERE product = 'nba' AND set_id_onchain IS NOT NULL AND play_id_onchain IS NOT NULL
                 GROUP BY nft_id
                HAVING count(DISTINCT (set_id_onchain, play_id_onchain)) = 1) ev
          JOIN public.topshot_moment_subeditions t ON t.nft_id = ev.nft_id
         WHERE t.subedition_id IS NOT NULL
           AND t.base_external_id <> ev.s::text || ':' || ev.p::text
           AND (t.subedition_id > 0) <> ev.std
      ) c
     WHERE EXISTS (SELECT 1 FROM public.editions e WHERE e.collection_id = ts
                      AND e.external_id = c.new_base || CASE WHEN c.sub > 0 THEN '::' || c.sub ELSE '' END)
     ORDER BY c.nft_id
     LIMIT GREATEST(p_max, 0);
    GET DIAGNOSTICS v_cand = ROW_COUNT;

    IF v_cand > 0 THEN
      v_res := public._apply_topshot_reconcile_run(v_run);
      v_sub := (v_res->>'map_rows')::int; v_wmc := (v_res->>'wmc_rows')::int; v_sales := (v_res->>'sales_rows')::int;
      v_mom := (v_res->>'moment_rows')::int; v_idm := (v_res->>'idmap_rows')::int;
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  -- ok = the run did not error. rows_found = candidates; rows_written = map rows repointed.
  PERFORM public.log_pipeline_run(
    'topshot-map-atlas-reconcile', v_start, v_cand, CASE WHEN v_err IS NULL THEN v_sub ELSE 0 END, 0,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('run_id', v_run, 'candidates', v_cand, 'map_rows', v_sub, 'wmc_rows', v_wmc,
                       'sales_rows', v_sales, 'moment_rows', v_mom, 'idmap_rows', v_idm, 'cap', p_max,
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_start) * 1000)::int));
  RETURN jsonb_build_object('ok', v_err IS NULL, 'run_id', v_run, 'candidates', v_cand, 'map_rows', v_sub,
                            'wmc_rows', v_wmc, 'sales_rows', v_sales, 'moment_rows', v_mom, 'idmap_rows', v_idm, 'error', v_err);
END;
$function$;

-- ── Chain lane: MomentMinted records behind a cursor ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reconcile_topshot_map_with_checkpoint(p_slice bigint DEFAULT 200000, p_max integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  ts       constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_run    uuid := gen_random_uuid();
  v_start  timestamptz := clock_timestamp();
  v_lo     bigint; v_hi bigint; v_top bigint; v_next bigint;
  v_wrapped boolean := false;
  v_cand   int := 0; v_missing int := 0;
  v_res    jsonb := '{}'::jsonb;
  v_err    text;
BEGIN
  BEGIN
    SELECT next_nft INTO v_lo FROM public.topshot_checkpoint_reconcile_cursor WHERE id = 1 FOR UPDATE;
    SELECT max(nft_id) INTO v_top FROM public.checkpoint_nft_meta WHERE c = 'ts';
    IF v_lo IS NULL OR v_top IS NULL OR v_lo > v_top THEN
      v_lo := 52038407; v_wrapped := true;
    END IF;
    v_hi := v_lo + GREATEST(p_slice, 1);

    INSERT INTO public.topshot_atlas_reconcile_log (run_id, nft_id, from_base, to_base, subedition, to_key, source)
    SELECT v_run, x.nft_id, x.old_base, x.new_base, x.sub,
           x.new_base || CASE WHEN x.sub > 0 THEN '::' || x.sub ELSE '' END, 'checkpoint'
      FROM (
        SELECT DISTINCT ON (t.nft_id) t.nft_id, t.base_external_id AS old_base, t.subedition_id AS sub,
               k.a::text || ':' || k.b::text AS new_base
          FROM public.checkpoint_nft_meta k
          JOIN public.topshot_moment_subeditions t ON t.nft_id = k.nft_id::text
         WHERE k.c = 'ts' AND k.nft_id >= v_lo AND k.nft_id < v_hi
           AND t.subedition_id IS NOT NULL
           AND t.base_external_id IS DISTINCT FROM k.a::text || ':' || k.b::text
         ORDER BY t.nft_id
      ) x
     WHERE public.topshot_checkpoint_base(x.nft_id) = x.new_base   -- every spork record agrees
       AND EXISTS (SELECT 1 FROM public.editions e WHERE e.collection_id = ts
                      AND e.external_id = x.new_base || CASE WHEN x.sub > 0 THEN '::' || x.sub ELSE '' END)
     ORDER BY x.nft_id
     LIMIT GREATEST(p_max, 0);
    GET DIAGNOSTICS v_cand = ROW_COUNT;

    IF v_cand > 0 THEN
      v_res := public._apply_topshot_reconcile_run(v_run);
    END IF;

    -- A full batch means the slice may hold more: stay on it. Otherwise move to the next slice.
    v_next := CASE WHEN v_cand >= p_max THEN v_lo ELSE v_hi END;
    UPDATE public.topshot_checkpoint_reconcile_cursor
       SET next_nft = v_next, sweeps = sweeps + CASE WHEN v_wrapped THEN 1 ELSE 0 END, updated_at = now()
     WHERE id = 1;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'topshot-map-checkpoint-reconcile', v_start, v_cand,
    CASE WHEN v_err IS NULL THEN COALESCE((v_res->>'map_rows')::int, 0) ELSE 0 END, 0,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    v_res || jsonb_build_object('run_id', v_run, 'candidates', v_cand, 'slice_lo', v_lo, 'slice_hi', v_hi,
                                'next_nft', v_next, 'wrapped', v_wrapped, 'newest_record', v_top, 'cap', p_max,
                                'duration_ms', (extract(epoch FROM clock_timestamp() - v_start) * 1000)::int));
  RETURN v_res || jsonb_build_object('ok', v_err IS NULL, 'run_id', v_run, 'candidates', v_cand,
                                     'slice_lo', v_lo, 'slice_hi', v_hi, 'next_nft', v_next, 'error', v_err);
END;
$function$;

-- anon-execute decision: REVOKED — scheduled writers only (service_role for an operator run).
REVOKE ALL ON FUNCTION public._apply_topshot_reconcile_run(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_topshot_map_with_atlas(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_topshot_map_with_checkpoint(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_topshot_map_with_atlas(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_topshot_map_with_checkpoint(bigint, integer) TO service_role;
COMMENT ON FUNCTION public.reconcile_topshot_map_with_checkpoint(bigint, integer) IS
  '#226: repoint Top Shot attribution (map, wmc, sales, moments, id map) to the chain MomentMinted set:play in checkpoint_nft_meta, a bounded nft-id slice per run behind topshot_checkpoint_reconcile_cursor. Log: topshot_atlas_reconcile_log (source = checkpoint).';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES ('topshot-map-checkpoint-reconcile', 300, 'medium',
        'Every 2 h at :57: repoints Top Shot moment attribution to the chain mint record (#226). Logs every run.',
        true)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-topshot-map-checkpoint-reconcile', '57 */2 * * *',
  'SELECT public.reconcile_topshot_map_with_checkpoint(200000, 2000)');
