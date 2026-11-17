-- audit_20260830_get_fmv_for_editions_latest_per_edition_lateral_instead_of_fmv_current_distinct_on
--
-- WHY: get_fmv_for_editions(p_collection_id, p_edition_ids[]) is the bulk FMV lookup behind the
-- four compute-*-pack-ev edge functions, lib/pack-dist-odds.ts, lib/pack-dist/fetchers.ts and
-- /api/wallet-cost-basis. pg_stat_statements (PostgREST, lifetime): 19,218 calls, mean 8,027 ms,
-- 154,258 s total — the single largest PostgREST consumer on the instance — 936 disk reads/call,
-- max 295 s. It read `fmv_current`, a DISTINCT ON (edition_id) ... ORDER BY computed_at DESC view
-- over ALL of fmv_snapshots. The planner does push `edition_id = ANY(...)` into the view, but a
-- DISTINCT ON still has to walk EVERY snapshot row of every requested edition through the
-- Merge Append (300 All Day editions -> 20,719 rows, 22,603 buffers; 800 Top Shot editions ->
-- 38,735 buffers) to keep the first one. Cold, that is 6.4 s for 300 editions.
--
-- FIX: one LATERAL `ORDER BY computed_at DESC LIMIT 1` probe per DISTINCT requested edition on
-- fmv_snapshots_*_edition_id_computed_at_idx, then the same two filters the view path applied
-- AFTER picking the latest row (latest row's collection_id = p_collection_id, fmv_usd NOT NULL).
-- Semantics are identical: the view filtered the latest row, not "latest row within the
-- collection", and so does this. Duplicate ids in the input still yield one row (DISTINCT).
-- Still LANGUAGE sql: the array parameter is an index condition either way, so the
-- param-blind generic plan (known-issues #52) is not a factor here.
--
-- VERIFIED before apply (probe copy get_fmv_for_editions__probe, dropped): set-equal (EXCEPT both
-- ways = 0) on 4 collections with 805/805/580/130-element arrays containing duplicates
-- (687/679/502/125 rows), NULL array -> 0 rows, empty array -> 0 rows, Top Shot ids under an
-- All Day collection -> 0 rows both. Buffers: 300 All Day editions 21,807 -> ~2,300
-- (6.4 s cold -> 13 ms); 800 Top Shot editions 38,735 -> 5,548.
--
-- REVERT: the prior body (from 20260512171327_mcp_phase1c_wrap_adapters.sql):
--   SELECT fc.edition_id, fc.fmv_usd FROM fmv_current fc
--   WHERE fc.collection_id = p_collection_id AND fc.edition_id = ANY(p_edition_ids) AND fc.fmv_usd IS NOT NULL;

-- anon-exec: intentional — same signature, ACLs unchanged by CREATE OR REPLACE; pack pages and the anon pack-EV readers call it (get_fmv_for_editions)
-- (marker added to the committed file after apply — comment only; parity is by name.)
CREATE OR REPLACE FUNCTION public.get_fmv_for_editions(p_collection_id uuid, p_edition_ids uuid[])
 RETURNS TABLE(edition_id uuid, fmv_usd numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
  SELECT lf.edition_id, lf.fmv_usd
  FROM (SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)) ids
  JOIN LATERAL (
    SELECT fs.edition_id, fs.fmv_usd, fs.collection_id
    FROM fmv_snapshots fs
    WHERE fs.edition_id = ids.id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) lf ON true
  WHERE lf.collection_id = p_collection_id
    AND lf.fmv_usd IS NOT NULL;
$function$;

COMMENT ON FUNCTION public.get_fmv_for_editions(uuid, uuid[]) IS
  'Bulk FMV lookup by edition_id array. Replaces PostgREST .in() chains that hit HTTP/2 stream errors with >200 UUIDs. Used by compute-allday-pack-ev v4+. 2026-08-30: latest-per-edition via LATERAL LIMIT 1 instead of the fmv_current DISTINCT ON view (same result set, ~86% fewer buffers).';
