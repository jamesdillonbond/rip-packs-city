-- 2026-10-31 (PT) — /insights/trade-in wallet arm, second read: the CHEAPEST NEXT PACK per
-- player (Trevor: "keep going" on the trade-in tools; features/trading.md open item 5).
-- For every player a wallet holds, the Moment(s) on the market that close the gap to
-- the next Top Shot This pack at the least cost: ceil(gap ÷ ASP) Moments of the edition
-- whose (ceil(gap ÷ ASP) × low ask) is smallest. `gap` is the portfolio's to_next_pack
-- (10 − ASP so far mod 10; a player with no ASP yet has a gap of the full $10).
--
-- ONE function, ONE scan: the portfolio (top players by ASP) and the next-pack plan share
-- the wallet_moments_cache read. Returning jsonb sidesteps PostgREST's silent 1,000-row
-- clamp on set-returning RPCs, and carries the counts the page needs: total_players (whole
-- wallet), players_with_fill (how many have a priced listing of that player right now).
-- A player with no listing carrying Top Shot's ASP has NO fill row — never a $0 one.
--
-- ⚠ THE NAME IS THE CATALOG'S (editions.player_name), NOT wallet_moments_cache.player_name.
-- The morning's get_topshot_trade_in_portfolio read coalesce(w.player_name, …): on 0xbd94…
-- 125 of 15,668 Moments carried a VARIANT spelling ("Luka Doncic" / "Luka Dončić",
-- "Demar DeRozan", "Jimmy Butler III") and every team Moment read "Team Moment" — so one
-- player's $10 math was SPLIT across two names and 30 teams were SUMMED under one. A name
-- is not a person (CLAUDE.md concierge rule 2): both functions now key on the catalog name
-- the view and the player pages use, so the next-pack join cannot miss on spelling.
-- Reading no wmc column but the keys ALSO makes the wallet read INDEX-ONLY
-- (idx_wmc_lock_wallet_coll_cover): 627 buffers for the 15,668-Moment wallet against
-- 13,270 scattered heap blocks before (EXPLAIN 2026-10-31: 823 ms cold vs 5.1–10.4 s).
-- The one Moment (of 15,668) with no catalog row at all has no name and is not counted.
--
-- Applied under this name via apply_migration; the `fill` key on each players row was
-- added minutes later with execute_sql (CREATE OR REPLACE of the same body) — this file
-- IS the live body (verify: prosrc against the $$ block).
--
-- SECURITY INVOKER: the caller's own read of anon-SELECT tables.
-- Revert: DROP FUNCTION public.get_topshot_trade_in_wallet(text, int); and re-apply the
-- 20261031182000 body of get_topshot_trade_in_portfolio (the wmc-name version).

CREATE OR REPLACE FUNCTION public.get_topshot_trade_in_wallet(p_wallet text, p_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH rows_ AS (
    SELECT coalesce(e.player_name, be.player_name) AS player_name, be.avg_sale_price AS asp
      FROM public.wallet_moments_cache w
      LEFT JOIN public.editions e
             ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
      LEFT JOIN public.badge_editions be
             ON be.collection_id = w.collection_id AND be.external_id = w.edition_key
     WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND w.wallet_address = lower(p_wallet)
  ), per_player AS (
    SELECT r.player_name,
           count(*)::int AS moments,
           count(r.asp)::int AS moments_with_asp,
           coalesce(sum(r.asp), 0) AS asp_sum
      FROM rows_ r
     WHERE r.player_name IS NOT NULL
     GROUP BY r.player_name
  ), gap AS (
    SELECT p.player_name, p.moments, p.moments_with_asp,
           round(p.asp_sum, 2) AS asp_total,
           floor(p.asp_sum / 10)::int AS packs,
           round(10 - (p.asp_sum - 10 * floor(p.asp_sum / 10)), 2) AS to_next_pack
      FROM per_player p
  ), lim AS (
    SELECT greatest(1, least(coalesce(p_limit, 200), 1000)) AS n
  ), cand AS (
    SELECT g.player_name, g.packs, g.to_next_pack,
           v.edition_id, v.external_id, v.set_name, v.printing, v.tier, v.series, v.asp, v.low_ask,
           ceil(g.to_next_pack / v.asp)::int AS moments_needed,
           round(ceil(g.to_next_pack / v.asp) * v.low_ask, 2) AS cost,
           row_number() OVER (PARTITION BY g.player_name
                              ORDER BY ceil(g.to_next_pack / v.asp) * v.low_ask,
                                       ceil(g.to_next_pack / v.asp),
                                       v.edition_id) AS rn
      FROM gap g
      JOIN public.v_insights_trade_in v ON v.player_name = g.player_name
  ), fills AS (
    SELECT player_name, packs, to_next_pack, edition_id, external_id, set_name, printing, tier, series,
           asp, low_ask, moments_needed, cost
      FROM cand WHERE rn = 1
  ), next_pack AS (
    SELECT jsonb_agg(to_jsonb(f) ORDER BY f.cost, f.player_name) AS j
      FROM (SELECT * FROM fills ORDER BY cost, player_name LIMIT (SELECT n FROM lim)) f
  ), players AS (
    -- each top-ASP player carries its own cheapest fill (null = no priced listing now),
    -- so a big player that is not among the cheapest fills still shows its path.
    SELECT jsonb_agg(to_jsonb(g) || jsonb_build_object('fill', to_jsonb(f)) ORDER BY g.asp_total DESC, g.player_name) AS j
      FROM (SELECT * FROM gap ORDER BY asp_total DESC, player_name LIMIT (SELECT n FROM lim)) g
      LEFT JOIN fills f ON f.player_name = g.player_name
  )
  SELECT jsonb_build_object(
    'wallet', lower(p_wallet),
    'total_players', (SELECT count(*) FROM gap),
    'players_with_fill', (SELECT count(*) FROM fills),
    'players', coalesce((SELECT j FROM players), '[]'::jsonb),
    'next_pack', coalesce((SELECT j FROM next_pack), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.get_topshot_trade_in_wallet(text, int) IS
  '/insights/trade-in ?wallet= arm, one scan: players = per player (most ASP first, p_limit ≤ 1000) the sum of Top Shot''s ASP over the wallet''s indexed Top Shot Moments, whole Top Shot This packs ($10 each) and the ASP to the next; next_pack = per player the cheapest listed Moment(s) of that player that close the gap (ceil(gap ÷ ASP) × low ask), cheapest first. total_players / players_with_fill count the whole wallet. A player with no priced listing has no fill row.';

REVOKE ALL ON FUNCTION public.get_topshot_trade_in_wallet(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_topshot_trade_in_wallet(text, int) TO anon, authenticated, service_role;

-- The morning function, re-keyed on the catalog name (same fix, same reason as above).
-- Live body re-read before this CREATE OR REPLACE (prosrc = the 20261031182000 file).
-- anon-exec: intentional — get_topshot_trade_in_portfolio is the public /insights/trade-in wallet arm (SECURITY INVOKER over anon-SELECT tables; grants set in 20261031182000, kept by CREATE OR REPLACE)
CREATE OR REPLACE FUNCTION public.get_topshot_trade_in_portfolio(p_wallet text, p_limit int DEFAULT 200)
RETURNS TABLE (
  player_name text,
  moments int,
  moments_with_asp int,
  asp_total numeric,
  packs int,
  to_next_pack numeric,
  total_players int
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH rows_ AS (
    SELECT coalesce(e.player_name, be.player_name) AS player_name, be.avg_sale_price AS asp
      FROM public.wallet_moments_cache w
      LEFT JOIN public.editions e
             ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
      LEFT JOIN public.badge_editions be
             ON be.collection_id = w.collection_id AND be.external_id = w.edition_key
     WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND w.wallet_address = lower(p_wallet)
  ), per_player AS (
    SELECT r.player_name,
           count(*)::int AS moments,
           count(r.asp)::int AS moments_with_asp,
           coalesce(sum(r.asp), 0) AS asp_sum
      FROM rows_ r
     WHERE r.player_name IS NOT NULL
     GROUP BY r.player_name
  )
  SELECT p.player_name,
         p.moments,
         p.moments_with_asp,
         round(p.asp_sum, 2) AS asp_total,
         floor(p.asp_sum / 10)::int AS packs,
         round(10 - (p.asp_sum - 10 * floor(p.asp_sum / 10)), 2) AS to_next_pack,
         (count(*) OVER ())::int AS total_players
    FROM per_player p
   ORDER BY p.asp_sum DESC, p.player_name
   LIMIT greatest(1, least(coalesce(p_limit, 200), 1000));
$$;
