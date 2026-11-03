-- 2026-11-02 (#226) — the checkpoint reconcile's slice stops at the newest mint record.
--
-- First runs (20261103020800) showed the cursor stepping a full 200k-id slice past the walk's frontier
-- (cursor 52,438,407 with records only to 52,191,290). Nothing is lost — the cursor wraps and the next
-- sweep catches late records — but during the backfill every run past the frontier is a wasted run and
-- a sweep takes longer than it needs to. Now v_hi = LEAST(v_lo + p_slice, newest record + 1); the cursor
-- reaches the frontier, then wraps.
--
-- Revert: re-apply reconcile_topshot_map_with_checkpoint from 20261103020800.
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
    -- Never past the newest record: a slice beyond it would advance the cursor over moments whose
    -- mint records have not landed yet (11-02: the cursor jumped 52.24M -> 52.44M with the walk at 52.19M).
    v_hi := LEAST(v_lo + GREATEST(p_slice, 1), v_top + 1);

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

-- anon-execute decision: REVOKED (unchanged).
REVOKE ALL ON FUNCTION public.reconcile_topshot_map_with_checkpoint(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_topshot_map_with_checkpoint(bigint, integer) TO service_role;
