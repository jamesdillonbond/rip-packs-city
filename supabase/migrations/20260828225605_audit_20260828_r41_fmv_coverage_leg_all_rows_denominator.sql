-- anon-exec: intentional — snapshot re-create with the SAME signature, which preserves the existing revoked ACL; verified post-apply: anon EXECUTE false, secdef drift 0 (rpc_thp_leg_fmv_coverage)
-- audit_20260828_r41_fmv_coverage_leg_all_rows_denominator
-- R41 consequence (Trevor decision, 2026-08-28): the accuracy-gate metric's Top Shot
-- denominator is ALL ROWS, not canonical-only. This drops the 2026-08-04 canonical
-- filter from rpc_thp_leg_fmv_coverage's `elig` CTE, so BOTH TS metrics it writes
-- change denominator to all rows (same population, no split-denominator trap):
--   topshot_fmv_high_med_share_pct: ~55.7 (canonical) -> ~38.4 (all rows; measured 2026-08-28)
--   topshot_fmv_pct_stale_30d:       ~0.0 (canonical) -> ~31.7 (all rows)
-- The stale arm's breach_at in v_rpc_trust_health is 50 — 31.7 does NOT breach, and the
-- arm becomes MORE sensitive to canonical drift: total = 32.6 floor + 0.674 x canonical_stale,
-- so breach now needs canonical_stale ~26% instead of 50%. The 32.6% structural floor is the
-- 6,426 non-canonical latest-FMV rows (97.5% stale dead residue) now inside the denominator.
-- The editions LEFT JOIN existed only for the filter and is dropped with it (orphan snapshots
-- for TS now COUNT, matching every other collection — the asymmetry was filter-induced).
-- No other consumer: the share metrics appear in NO view or function (verified via strpos,
-- not ILIKE — underscore is a LIKE wildcard); pin file updated in the same commit.
-- Revert: restore the previous elig CTE:
--     elig AS (
--       SELECT l.collection_id, l.edition_id, l.computed_at, l.confidence
--       FROM latest l
--       LEFT JOIN public.editions e ON e.id = l.edition_id
--       WHERE l.collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
--          OR e.external_id::text ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
--     ),
-- and revert the pin-file commit. Same signature => ACLs preserved (no re-grant needed).

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_fmv_coverage()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '240s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp();
BEGIN
  BEGIN
    WITH latest AS (
      SELECT DISTINCT ON (fs.collection_id, fs.edition_id)
             fs.collection_id, fs.edition_id, fs.computed_at, fs.confidence
      FROM public.fmv_snapshots fs
      ORDER BY fs.collection_id, fs.edition_id, fs.computed_at DESC
    ),
    elig AS (
      SELECT l.collection_id, l.edition_id, l.computed_at, l.confidence
      FROM latest l
    ),
    agg AS (
      SELECT elig.collection_id,
             round(100.0 * count(*) FILTER (WHERE elig.computed_at < (now() - '30 days'::interval))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS pct_stale_30d,
             round(100.0 * count(*) FILTER (WHERE elig.confidence IN ('HIGH','MEDIUM'))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS high_med_pct
      FROM elig GROUP BY elig.collection_id
    ),
    want(metric, collection_id) AS (
      VALUES ('topshot_fmv_pct_stale_30d', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_pct_stale_30d',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_pct_stale_30d', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_pct_stale_30d',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_pct_stale_30d',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    want_share(metric, collection_id) AS (
      VALUES ('topshot_fmv_high_med_share_pct', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_high_med_share_pct',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_high_med_share_pct', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_high_med_share_pct',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_high_med_share_pct',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    resolved AS (
      SELECT w.metric, COALESCE(a.pct_stale_30d, 0::numeric) AS value
      FROM want w LEFT JOIN agg a ON a.collection_id = w.collection_id
      UNION ALL
      SELECT w.metric, COALESCE(a.high_med_pct, 0::numeric) AS value
      FROM want_share w LEFT JOIN agg a ON a.collection_id = w.collection_id
    )
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT r.metric, r.value, now(),
           round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM resolved r
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['topshot_fmv_pct_stale_30d','allday_fmv_pct_stale_30d','golazos_fmv_pct_stale_30d',
                      'ufc_fmv_pct_stale_30d','candy_fmv_pct_stale_30d',
                      'topshot_fmv_high_med_share_pct','allday_fmv_high_med_share_pct','golazos_fmv_high_med_share_pct',
                      'ufc_fmv_high_med_share_pct','candy_fmv_high_med_share_pct']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;
