-- Latest FMV snapshot per edition, materialised. The thing the `fmv_current`
-- VIEW pretends to be.
--
-- WHY (measured today, not inferred):
-- Every entity grid that orders by FMV runs one LEFT JOIN LATERAL over
-- fmv_snapshots PER CANDIDATE EDITION. On an IOPS-throttled instance the cost is
-- random reads, so it is invisible warm and brutal cold:
--   get_series_editions('nba-top-shot','series-7')  -- 4,895 editions
--     06:00 UTC, quiet, fully warm ......    219 ms      125 reads
--     17:20 UTC, under load ............. 47,669 ms    2,926 reads
-- The 8 s PostgREST-bound ceiling fires at the second one, and the page renders
-- with an empty grid (`STRUCTURAL — throwing`, degraded to the SECTION).
-- ⚠ My earlier "26/26 return 200 with full payloads" was measured in that quiet
-- window and did NOT hold under daytime load. Warm timings hide read-bound work.
--
-- The whole population computed set-based ONCE is cheap, because it is one
-- ordered pass instead of 27,075 random probes:
--   DISTINCT ON (edition_id) over all partitions: 1.86 s, 687 physical reads,
--   27,075 rows out of 1,228,900 scanned.
-- A full rebuild therefore costs less than a single cold page view does today.
--
-- WRITE PATTERN: upsert + orphan sweep, deliberately NOT truncate-and-insert.
-- TRUNCATE takes ACCESS EXCLUSIVE for the length of the rebuild transaction and
-- this table sits on a public page's hot path. ⓘ The "delete-then-insert, never
-- upsert" rule in the migration checklist is about `fmv_snapshots` itself — a
-- partitioned HISTORY table where duplicate rows are the point. This is derived
-- current-state keyed by edition_id, where upsert is the correct shape.
--
-- ⚠ NOT a price source. It is a copy of the newest fmv_snapshots row per
-- edition, refreshed hourly, and is for ORDERING and bulk aggregation. Anything
-- that DISPLAYS a price to a collector should keep reading fmv_snapshots live —
-- see the get_series_editions migration, which uses this table to pick the top
-- 100 and then re-reads the live values for exactly those 100.
--
-- REVERT: DROP FUNCTION public.refresh_edition_fmv_current();
--         DROP TABLE public.edition_fmv_current;

CREATE TABLE IF NOT EXISTS public.edition_fmv_current (
  edition_id      uuid PRIMARY KEY,
  collection_id   uuid NOT NULL,
  fmv_usd         numeric,
  floor_price_usd numeric,
  confidence      public.fmv_confidence,
  computed_at     timestamptz,
  refreshed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_edition_fmv_current_coll_fmv
  ON public.edition_fmv_current (collection_id, fmv_usd DESC NULLS LAST);

ALTER TABLE public.edition_fmv_current ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated grants: the only readers are SECURITY DEFINER functions,
-- which do not need them. RLS on from the start so
-- check_public_security_invariants() never sees rls_off_base_table for it —
-- series_detail_rollup shipped without it and sat flagged until today.
REVOKE ALL ON TABLE public.edition_fmv_current FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.edition_fmv_current TO service_role;

COMMENT ON TABLE public.edition_fmv_current IS
  'Latest fmv_snapshots row per edition, refreshed hourly by refresh_edition_fmv_current() inside refresh_series_detail_rollup(). For ORDERING and bulk aggregation only - never as the displayed price. A missing row means "not yet refreshed", so callers must fall back to a live read rather than treat it as "no FMV".';

CREATE OR REPLACE FUNCTION public.refresh_edition_fmv_current()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    int;
  v_pruned  int;
BEGIN
  WITH latest AS MATERIALIZED (
    SELECT DISTINCT ON (s.edition_id)
           s.edition_id, s.collection_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
    FROM fmv_snapshots s
    ORDER BY s.edition_id, s.computed_at DESC
  )
  INSERT INTO edition_fmv_current AS t
    (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)
  SELECT l.edition_id, l.collection_id, l.fmv_usd, l.floor_price_usd, l.confidence, l.computed_at, now()
  FROM latest l
  ON CONFLICT (edition_id) DO UPDATE SET
    collection_id   = EXCLUDED.collection_id,
    fmv_usd         = EXCLUDED.fmv_usd,
    floor_price_usd = EXCLUDED.floor_price_usd,
    confidence      = EXCLUDED.confidence,
    computed_at     = EXCLUDED.computed_at,
    refreshed_at    = EXCLUDED.refreshed_at;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- An edition whose snapshots were deleted must not keep a stale current row.
  DELETE FROM edition_fmv_current t
  WHERE NOT EXISTS (SELECT 1 FROM fmv_snapshots s WHERE s.edition_id = t.edition_id);
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  RETURN jsonb_build_object(
    'upserted', v_rows,
    'pruned', v_pruned,
    'duration_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_edition_fmv_current() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_edition_fmv_current() TO postgres, service_role, cron_heavy;