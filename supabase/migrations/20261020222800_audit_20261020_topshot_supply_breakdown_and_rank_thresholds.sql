-- audit_20261020_topshot_supply_breakdown_and_rank_thresholds
-- anon-exec: NOT intentional for get_topshot_supply_breakdown — read by the service role (pages, Cowork dashboard) only; EXECUTE granted to service_role.
-- anon-exec: NOT intentional for get_topshot_player_rank_thresholds — read by the service role (pages, Cowork dashboard) only; EXECUTE granted to service_role.
--
-- Series 2026-27 (tip-off 2026-10-20) is built on trade-in auctions that burn rookie supply all season
-- and on season-long player/team leaderboards (Top Shot blog, 2026-10-14). Two reads for it:
--
-- 1. get_topshot_supply_breakdown(player, set, series) — per canonical Top Shot edition:
--      minted          editions.circulation_count (the mint count, not what exists)
--      burned          badge_editions.burned (Atlas); NULL = not reported, NEVER coalesced to 0
--      live_supply     minted - burned; NULL when burned is NULL
--      locked          badge_editions.locked (Atlas); NULL = not reported
--      top_shot_held   walk-confirmed Moments held by an address in flowty_excluded_addresses
--                      (Top Shot's pack-distribution / buyback / routing accounts)
--      collector_held  walk-confirmed Moments held by everyone else
--      collectors      distinct collectors (resolve_canonical_owner groups) holding it
--      indexed         walk-confirmed rows the ownership index holds for it
--      census_complete indexed is within 98–102 % of live_supply — only then do top_shot_held +
--                      collector_held describe the whole edition (a gap is index coverage, not supply)
--    Needs a player or a set (raises 22023 otherwise) so no caller scans the whole catalog.
--    Cross-check on apply (2026-10-20, Series 8 Rookie Debut Standard, 61 editions): Atlas burned
--    8,206 of 61,000 vs 8,213 walk-missed rows — two independent sources agree within 7.
--
-- 2. get_topshot_player_rank_thresholds(player) — what the 1st / 3rd / 10th / 26th collector on a
--    player's board holds (estimated value and Moment count), from topshot_rookie_collector_leaderboard_mv
--    (system accounts excluded since 20261020222700). 1/3/26 are the season's reward lines (Blue Chip /3,
--    Rookie Yearbook /26), 10 is Squad Goals' team line. A PROXY: Top Shot ranks LOCKED Top Shot Score
--    (≈10 × max(price paid, average sale price) per Moment; support.nbatopshot.com) — this ranks every
--    walk-confirmed holding by RPC FMV, locked or not. The 2026 class needs topshot_2025_rookie_players'
--    successor before its boards exist; until then a 2026 rookie returns four NULL rows, collectors 0.
--
-- REVERT: DROP FUNCTION public.get_topshot_supply_breakdown(text, text, integer);
--         DROP FUNCTION public.get_topshot_player_rank_thresholds(text);

CREATE FUNCTION public.get_topshot_supply_breakdown(
  p_player_name text DEFAULT NULL,
  p_set_name    text DEFAULT NULL,
  p_series      integer DEFAULT NULL)
RETURNS TABLE(
  edition_external_id text,
  player_name         text,
  set_name            text,
  series              smallint,
  printing            text,
  tier                text,
  minted              integer,
  burned              integer,
  live_supply         integer,
  locked              integer,
  top_shot_held       integer,
  collector_held      integer,
  collectors          integer,
  indexed             integer,
  census_complete     boolean,
  burned_as_of        timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  IF p_player_name IS NULL AND p_set_name IS NULL THEN
    RAISE EXCEPTION 'get_topshot_supply_breakdown needs p_player_name or p_set_name'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH eds AS (
    SELECT e.external_id::text AS ext, e.player_name AS pn, e.set_name AS sn, e.series AS se,
           coalesce(e.subedition_name, 'Standard') AS pr, e.tier::text AS ti, e.circulation_count AS mi
      FROM public.editions e
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       AND coalesce(e.circulation_count, 0) > 0
       AND (p_player_name IS NULL OR e.player_name = p_player_name)
       AND (p_set_name    IS NULL OR e.set_name    = p_set_name)
       AND (p_series      IS NULL OR e.series      = p_series)
  ), held AS (
    SELECT o.edition_external_id AS ext,
           count(*)::int                                          AS n_indexed,
           count(*) FILTER (WHERE x.address IS NOT NULL)::int     AS n_sys,
           (count(DISTINCT public.resolve_canonical_owner(o.owner_address))
              FILTER (WHERE x.address IS NULL))::int              AS n_collectors
      FROM public.topshot_ownership o
      JOIN eds ON eds.ext = o.edition_external_id
      LEFT JOIN public.flowty_excluded_addresses x ON x.address = o.owner_address
     WHERE o.walk_missed_at IS NULL
     GROUP BY o.edition_external_id
  )
  SELECT eds.ext, eds.pn, eds.sn, eds.se, eds.pr, eds.ti, eds.mi,
         be.burned,
         CASE WHEN be.burned IS NOT NULL THEN eds.mi - be.burned END,
         be.locked,
         h.n_sys,
         h.n_indexed - h.n_sys,
         h.n_collectors,
         h.n_indexed,
         coalesce(be.burned IS NOT NULL AND h.n_indexed IS NOT NULL
                  AND h.n_indexed BETWEEN ceil((eds.mi - be.burned) * 0.98)
                                      AND floor((eds.mi - be.burned) * 1.02), false),
         be.updated_at
    FROM eds
    LEFT JOIN held h ON h.ext = eds.ext
    LEFT JOIN public.badge_editions be
           ON be.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND be.external_id = eds.ext
   ORDER BY eds.pn, eds.se, eds.sn, eds.mi DESC, eds.ext;
END
$function$;

COMMENT ON FUNCTION public.get_topshot_supply_breakdown(text, text, integer) IS
  'Per canonical Top Shot edition: minted, burned (Atlas; NULL = not reported), live supply, locked, held by Top Shot''s own accounts (flowty_excluded_addresses), held by collectors, collectors, indexed rows, and whether the walk-confirmed index covers 98–102 % of live supply. Needs p_player_name or p_set_name. audit_20261020.';

REVOKE ALL ON FUNCTION public.get_topshot_supply_breakdown(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_supply_breakdown(text, text, integer) TO service_role;

CREATE FUNCTION public.get_topshot_player_rank_thresholds(p_player_name text)
RETURNS TABLE(rank_cutoff integer, est_value_usd numeric, moments_held bigint, collectors bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH b AS (
    SELECT lb.est_value_usd, lb.moments_held,
           row_number() OVER (ORDER BY lb.rnk, lb.est_value_usd DESC, lb.moments_held DESC, lb.wallet_address) AS pos
      FROM public.topshot_rookie_collector_leaderboard_mv lb
     WHERE lb.player_name = p_player_name
  )
  SELECT c.cut, b.est_value_usd, b.moments_held, (SELECT count(*) FROM b)
    FROM unnest(ARRAY[1, 3, 10, 26]) AS c(cut)
    LEFT JOIN b ON b.pos = c.cut
   ORDER BY c.cut;
$function$;

COMMENT ON FUNCTION public.get_topshot_player_rank_thresholds(text) IS
  'What the 1st/3rd/10th/26th collector on a 2025-rookie Top Shot board holds (RPC-FMV value, Moment count) and how many collectors the board has, from topshot_rookie_collector_leaderboard_mv (Top Shot system accounts excluded). A proxy for Top Shot''s locked-TSS boards: it counts every walk-confirmed holding at FMV, locked or not. NULL row = fewer collectors than that rank. audit_20261020.';

REVOKE ALL ON FUNCTION public.get_topshot_player_rank_thresholds(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_player_rank_thresholds(text) TO service_role;
