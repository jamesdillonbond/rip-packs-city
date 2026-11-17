-- audit_20260902_get_top_movers_own_collection_join_and_lateral_past
--
-- Two defects in `get_top_movers` (the RPC behind the profile page's "Top
-- Movers · 7d" panel), found while measuring why it times out (57014 twice
-- tonight, both on the 19,385-row wallet 0xbd94cade097e50ac):
--
-- 1. FALSE CLAIM. `owned` joined `editions e ON e.external_id = wmc.edition_key`
--    with NO collection predicate when p_collection_id is NULL (the panel's
--    call). `external_id` is only unique per (external_id, collection_id), so
--    a Top Shot / All Day Moment with edition_key '391' also matched LaLiga
--    Golazos edition 391. Same-snapshot diff, old vs new, on that wallet:
--    the old body's three biggest "losers" were Golazos editions the wallet
--    does not hold — Iker Casillas −$1,999.06, Zlatan Ibrahimovic −$408.33,
--    Nemanja Gudelj −$187.00 (owned_same_collection = 0 for all three) — and
--    9,196 vs 9,064 "owned" editions overall. Gainers were identical. The
--    panel published a −$2K loss on a Moment the collector never owned.
--    Fix: `AND e.collection_id = wmc.collection_id`.
--
-- 2. COST. `latest` and `past` were each a DISTINCT ON over fmv_snapshots
--    merge-joined against the owned set — the planner walked the ENTIRE
--    fmv_snapshots_2026 index (1,399,709 rows, then 1,285,003 again) to pick
--    ~9k rows each. Measured warm on that wallet: **110,495 buffers / 5.5 s**.
--    New shape: `latest` from edition_fmv_current (PK probe; the hourly
--    materialised latest-per-edition, the display source database.md
--    sanctions), `past` as a per-edition LATERAL `ORDER BY computed_at DESC
--    LIMIT 1` under `computed_at <= threshold` (rides the
--    (edition_id, computed_at) index, one probe per edition):
--    **58,300 buffers / 4.4 s** (−47% buffers; 21k of the remainder is the
--    wallet's own wmc scan, which no shape avoids). Cold timings not quoted.
--    ⚠ Not a guarantee against 57014 under saturation — halved, not solved.
--
-- Output shape unchanged: json {gainers:[…], losers:[…]} with edition_id,
-- player_name, set_name, current_fmv, past_fmv, delta, pct_change. current_fmv
-- now lags by up to one hour (edition_fmv_current), as the sniper and series
-- pages already do.
--
-- ⚠ This function had NO migration in the repo (live-only, like sets_summary
-- was) — this file is also its first record.
--
-- anon-exec: unchanged (get_top_movers) — CREATE OR REPLACE with the same signature; invoker-rights (not SECURITY DEFINER), ACL {anon,authenticated,service_role EXECUTE} preserved as it was, verified before and after.
--
-- REVERT: re-create with the previous body (recorded in
-- docs/overnight/ledger.md entry of 2026-09-02 "get_top_movers"), i.e. the
-- two DISTINCT ON CTEs and the collection-blind join.

CREATE OR REPLACE FUNCTION public.get_top_movers(p_wallet text, p_days integer DEFAULT 7, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_threshold timestamptz := now() - (p_days || ' days')::interval;
  v_result json;
BEGIN
  WITH owned AS (
    SELECT DISTINCT e.id AS edition_id, e.player_name, e.set_name, e.external_id
    FROM wallet_moments_cache wmc
    JOIN editions e
      ON e.external_id = wmc.edition_key
     AND e.collection_id = wmc.collection_id   -- external_id is only unique PER COLLECTION
     AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
    WHERE wmc.wallet_address = p_wallet
      AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
  ),
  movers AS (
    SELECT
      o.edition_id, o.player_name, o.set_name,
      l.fmv_usd AS current_fmv, p.fmv_usd AS past_fmv,
      (l.fmv_usd - p.fmv_usd) AS delta,
      CASE WHEN p.fmv_usd > 0 THEN ((l.fmv_usd - p.fmv_usd) / p.fmv_usd) * 100 ELSE NULL END AS pct_change
    FROM owned o
    JOIN edition_fmv_current l ON l.edition_id = o.edition_id
    JOIN LATERAL (
      SELECT fs.fmv_usd
      FROM fmv_snapshots fs
      WHERE fs.edition_id = o.edition_id
        AND fs.computed_at <= v_threshold
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) p ON true
    WHERE l.fmv_usd IS NOT NULL AND p.fmv_usd IS NOT NULL
  ),
  gainers AS (SELECT * FROM movers WHERE delta > 0 ORDER BY delta DESC LIMIT 5),
  losers AS (SELECT * FROM movers WHERE delta < 0 ORDER BY delta ASC LIMIT 5)
  SELECT json_build_object(
    'gainers', COALESCE((SELECT json_agg(row_to_json(g)) FROM gainers g), '[]'::json),
    'losers',  COALESCE((SELECT json_agg(row_to_json(l)) FROM losers l), '[]'::json)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;
