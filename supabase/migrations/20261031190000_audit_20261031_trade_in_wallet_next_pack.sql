-- 2026-10-31 (PT) — FIRST apply of get_topshot_trade_in_wallet (the /insights/trade-in
-- wallet arm's cheapest-next-pack read). ⚠ SUPERSEDED four minutes later by
-- 20261031190500_audit_20261031_trade_in_wallet_next_pack_catalog_name.sql, which
-- re-keys the player name on the CATALOG (editions.player_name) after a probe showed
-- wallet_moments_cache.player_name splitting one player across two spellings and
-- summing 30 teams under "Team Moment". This file exists because migration-parity
-- matches prod's schema_migrations on NAME, and this name was applied: it carries the
-- body exactly as applied so the committed history is the DB's history. Do not apply
-- it on its own — the later file holds the live body and the full rationale.
-- Revert (of the pair): DROP FUNCTION public.get_topshot_trade_in_wallet(text, int);

CREATE OR REPLACE FUNCTION public.get_topshot_trade_in_wallet(p_wallet text, p_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH rows_ AS (
    SELECT coalesce(w.player_name, be.player_name) AS player_name, be.avg_sale_price AS asp
      FROM public.wallet_moments_cache w
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
  ), players AS (
    SELECT jsonb_agg(to_jsonb(g) ORDER BY g.asp_total DESC, g.player_name) AS j
      FROM (SELECT * FROM gap ORDER BY asp_total DESC, player_name LIMIT (SELECT n FROM lim)) g
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
