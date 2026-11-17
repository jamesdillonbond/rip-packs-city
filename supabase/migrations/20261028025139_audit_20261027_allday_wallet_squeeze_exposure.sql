-- audit_20261027: NFL All Day leg for the wallet squeeze check (/insights/squeeze-check, concierge check_wallet_squeeze)
-- (All Day ↔ Top Shot parity, pass 10).
--
-- get_wallet_squeeze_exposure is Top Shot's only. This is the same body — same buckets (< 25 / 25–50 / 50–75 / ≥ 75 %
-- squeeze, moments-weighted, with an FMV total each), same top-10 — over the wallet's All Day holdings in
-- wallet_moments_cache and All Day badge_editions locked / burned (the daily Atlas ingest). One difference, on
-- purpose: an edition's squeeze is NULL unless BOTH counts were read (Top Shot's COALESCEs a missing count to 0);
-- 0 such editions on All Day today. An unindexed wallet returns total_moments NULL, exactly like Top Shot's — the
-- route, not this function, tells "not indexed yet" from "holds nothing" (wallet_backfill_state).
-- anon-exec: revoked (get_allday_wallet_squeeze_exposure) — service-role read by /api/public/insights/squeeze-check; REVOKE below.
--
-- Revert: DROP FUNCTION public.get_allday_wallet_squeeze_exposure(text);

CREATE OR REPLACE FUNCTION public.get_allday_wallet_squeeze_exposure(p_wallet text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH holdings AS (
    SELECT
      w.edition_key,
      COUNT(*) AS held,
      SUM(COALESCE(w.fmv_usd, 0)) AS fmv_total,
      COUNT(*) FILTER (WHERE w.fmv_usd IS NOT NULL) AS fmv_covered,
      MAX(e.player_name)  AS player_name,
      MAX(e.set_name)     AS set_name,
      MAX(e.tier::text)   AS tier,
      MAX(e.circulation_count) AS circulation,
      MAX(be.locked)      AS locked,
      MAX(be.burned)      AS burned,
      MAX(
        CASE WHEN COALESCE(e.circulation_count, be.circulation_count, 0) > 0
              AND be.locked IS NOT NULL AND be.burned IS NOT NULL
          THEN ROUND(
            100.0 * (be.locked + be.burned)
            / COALESCE(e.circulation_count, be.circulation_count)::numeric, 1
          )
        END
      ) AS squeeze_pct
    FROM wallet_moments_cache w
    LEFT JOIN editions e
      ON e.external_id::text = w.edition_key
     AND e.collection_id = w.collection_id
    LEFT JOIN badge_editions be
      ON be.external_id = w.edition_key
     AND be.collection_id = w.collection_id
    WHERE w.wallet_address = LOWER(p_wallet)
      AND w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    GROUP BY w.edition_key
  ),
  bucket_summary AS (
    SELECT
      jsonb_build_object(
        'liquid', jsonb_build_object(
          'editions', COUNT(*) FILTER (WHERE squeeze_pct IS NULL OR squeeze_pct < 25),
          'moments',  COALESCE(SUM(held) FILTER (WHERE squeeze_pct IS NULL OR squeeze_pct < 25), 0),
          'fmv_usd',  ROUND(COALESCE(SUM(fmv_total) FILTER (WHERE squeeze_pct IS NULL OR squeeze_pct < 25), 0), 2)
        ),
        'moderate', jsonb_build_object(
          'editions', COUNT(*) FILTER (WHERE squeeze_pct >= 25 AND squeeze_pct < 50),
          'moments',  COALESCE(SUM(held) FILTER (WHERE squeeze_pct >= 25 AND squeeze_pct < 50), 0),
          'fmv_usd',  ROUND(COALESCE(SUM(fmv_total) FILTER (WHERE squeeze_pct >= 25 AND squeeze_pct < 50), 0), 2)
        ),
        'squeezed', jsonb_build_object(
          'editions', COUNT(*) FILTER (WHERE squeeze_pct >= 50 AND squeeze_pct < 75),
          'moments',  COALESCE(SUM(held) FILTER (WHERE squeeze_pct >= 50 AND squeeze_pct < 75), 0),
          'fmv_usd',  ROUND(COALESCE(SUM(fmv_total) FILTER (WHERE squeeze_pct >= 50 AND squeeze_pct < 75), 0), 2)
        ),
        'extreme', jsonb_build_object(
          'editions', COUNT(*) FILTER (WHERE squeeze_pct >= 75),
          'moments',  COALESCE(SUM(held) FILTER (WHERE squeeze_pct >= 75), 0),
          'fmv_usd',  ROUND(COALESCE(SUM(fmv_total) FILTER (WHERE squeeze_pct >= 75), 0), 2)
        )
      ) AS buckets,
      SUM(held) AS total_moments,
      COUNT(*) AS total_editions,
      ROUND(COALESCE(SUM(fmv_total), 0), 2) AS total_fmv_usd,
      SUM(fmv_covered) AS moments_with_fmv,
      COUNT(*) FILTER (WHERE squeeze_pct IS NOT NULL) AS editions_with_badge_coverage
    FROM holdings
  ),
  top_squeezed AS (
    SELECT COALESCE(jsonb_agg(row ORDER BY squeeze_pct DESC, held DESC), '[]'::jsonb) AS rows
    FROM (
      SELECT
        squeeze_pct,
        held,
        jsonb_build_object(
          'player_name', player_name,
          'set_name',    set_name,
          'tier',        tier,
          'edition_key', edition_key,
          'circulation', circulation,
          'locked',      locked,
          'burned',      burned,
          'squeeze_pct', squeeze_pct,
          'held',        held,
          'fmv_usd',     ROUND(fmv_total, 2)
        ) AS row
      FROM holdings
      WHERE squeeze_pct IS NOT NULL
      ORDER BY squeeze_pct DESC, held DESC
      LIMIT 10
    ) sub
  )
  SELECT jsonb_build_object(
    'wallet',                       LOWER(p_wallet),
    'collection',                   'nfl_all_day',
    'total_moments',                bs.total_moments,
    'total_editions',               bs.total_editions,
    'total_fmv_usd',                bs.total_fmv_usd,
    'moments_with_fmv',             bs.moments_with_fmv,
    'editions_with_badge_coverage', bs.editions_with_badge_coverage,
    'buckets',                      bs.buckets,
    'top_squeezed',                 ts.rows,
    'computed_at',                  NOW()
  )
  FROM bucket_summary bs CROSS JOIN top_squeezed ts;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_allday_wallet_squeeze_exposure(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_wallet_squeeze_exposure(text) TO service_role;
