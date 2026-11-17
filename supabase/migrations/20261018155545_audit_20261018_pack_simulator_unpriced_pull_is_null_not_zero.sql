-- get_pack_for_simulator: an unpriced pool edition is NULL, not a measured $0.
--
-- WHY (2026-10-18 ~8:55 AM PT, Claude Code cloud; pack-ev.md Now 2, the Pack Reality COALESCE(…,0)
-- audit): the RPC emitted 'fmv_usd' and 'floor_price_usd' as ROUND(COALESCE(x, 0), 2). The pack
-- simulator (PackSimulatorClient.tsx) already treats an absent FMV as absent — `hasFmv` counts
-- covered slots and an "N / M pulls had FMV … a lower bound" disclosure renders when coverage is
-- partial — but it could never fire, because the RPC never sent a null: an unpriced pull rendered as
-- "$0.00", was averaged into "Avg pack value" and counted as a miss in "% beat retail". Measured live:
-- 1,210 of 220,316 pullable pool rows (drop_weight > 0) have no FMV, across 436 distributions.
-- WHAT: both fields drop the COALESCE (ROUND(NULL) is NULL). The ORDER BY keeps COALESCE(fmv,0) —
-- sorting only. Signature, SECURITY DEFINER, search_path, statement_timeout and STABLE are unchanged.
-- anon-exec: unchanged (get_pack_for_simulator) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false, authenticated=false (service_role via /api/pack-simulator).
--
-- REVERT: re-run this file with both 'fmv_usd' / 'floor_price_usd' lines restored to
--   ROUND(COALESCE(p.fmv_usd, 0)::numeric, 2) / ROUND(COALESCE(p.floor_price_usd, 0)::numeric, 2).

CREATE OR REPLACE FUNCTION public.get_pack_for_simulator(p_collection_id uuid, p_dist_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_pack jsonb;
  v_metrics jsonb;
  v_pool jsonb;
BEGIN
  SELECT jsonb_build_object(
    'dist_id',           pd.dist_id,
    'title',             COALESCE(pd.title, pd.metadata->>'name'),
    'image_url',         COALESCE(pd.metadata->>'thumbnail', pd.image_url),
    'tier',              lower(pd.metadata->>'tier'),
    'pack_type',         pd.metadata->>'pack_type',
    'slots',             (pd.metadata->>'number_of_pack_slots')::int,
    'retail_price_usd',
      CASE
        WHEN (pd.metadata->>'retail_price_usd') IS NULL THEN NULL
        WHEN ((pd.metadata->>'retail_price_usd')::numeric) >= 1000000 THEN
          ROUND(((pd.metadata->>'retail_price_usd')::numeric) / 100000000, 2)
        ELSE ROUND((pd.metadata->>'retail_price_usd')::numeric, 2)
      END,
    'total_minted',      pd.total_minted,
    'total_opened',      pd.total_opened,
    'total_sealed',      pd.total_sealed,
    'depletion_pct',     pd.depletion_pct
  )
  INTO v_pack
  FROM public.pack_distributions pd
  WHERE pd.collection_id = p_collection_id AND pd.dist_id = p_dist_id;

  IF v_pack IS NULL THEN
    RETURN jsonb_build_object('error', 'pack not found', 'dist_id', p_dist_id);
  END IF;

  SELECT to_jsonb(pgm.*) - 'collection_id' - 'dist_id'
  INTO v_metrics
  FROM public.pack_grail_metrics_mv pgm
  WHERE pgm.collection_id = p_collection_id AND pgm.dist_id = p_dist_id;

  WITH pool AS (
    SELECT
      pdp.edition_id,
      COALESCE(e.external_id, e.id::text)                                        AS edition_slug,
      e.player_name,
      e.set_name,
      e.tier::text                                                                AS tier,
      e.circulation_count,
      e.thumbnail_url,
      pdp.drop_weight,
      fmv.fmv_usd,
      fmv.floor_price_usd,
      fmv.confidence::text                                                        AS fmv_confidence
    FROM public.pack_drop_pool pdp
    JOIN public.editions e ON e.id = pdp.edition_id
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.floor_price_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.edition_id = pdp.edition_id
      ORDER BY fs.computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE pdp.collection_id = p_collection_id
      AND pdp.dist_id = p_dist_id
      AND pdp.drop_weight > 0
  ),
  total AS (SELECT SUM(drop_weight) AS w FROM pool)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'edition_id',        p.edition_id,
      'edition_slug',      p.edition_slug,
      'player_name',       p.player_name,
      'set_name',          p.set_name,
      'tier',              p.tier,
      'circulation_count', p.circulation_count,
      'thumbnail_url',     p.thumbnail_url,
      'drop_weight',       p.drop_weight,
      'hit_probability',   CASE WHEN t.w > 0 THEN ROUND((p.drop_weight / t.w)::numeric, 6) ELSE NULL END,
      'fmv_usd',           ROUND(p.fmv_usd::numeric, 2),
      'floor_price_usd',   ROUND(p.floor_price_usd::numeric, 2),
      'fmv_confidence',    p.fmv_confidence
    )
    ORDER BY COALESCE(p.fmv_usd, 0) * p.drop_weight DESC, p.drop_weight DESC
  ), '[]'::jsonb)
  INTO v_pool
  FROM pool p CROSS JOIN total t;

  RETURN jsonb_build_object(
    'pack', v_pack,
    'metrics', COALESCE(v_metrics, '{}'::jsonb),
    'pool', v_pool,
    'computed_at', now(),
    'note', 'Pool excludes exhausted editions (drop_weight=0). Probabilities sum to 1.0. For NFL/UFC/Pinnacle/Golazos, weighting is uniform; for NBA Top Shot, drop_weight varies by edition.'
  );
END;
$function$;
