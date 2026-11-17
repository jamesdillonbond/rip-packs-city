-- audit_20260927_panini_set_progress
--
-- Panini Sets tab backend (2026-09-27, Candy/Panini parity). One row per
-- `panini_editions.set_name` (62 sets on the WC Prizm plane), read by
-- /api/panini-set-progress through the service role.
--
-- Panini publishes NO checklist: an edition is known to RPC only once a card of
-- it has been listed. So every count here is "seen", never "exists":
--   · editions_seen / players_seen — the editions of this set RPC has indexed.
--   · asked / cost_usd — editions with a listed serial whose ask was re-read in
--     the last 7 days (the same confirmation window as panini_market_board), and
--     the sum of each one's lowest such ask. Editions with no confirmed ask are
--     counted separately (`unasked`) and are NOT priced — the cost is a floor.
--   · With p_username: `owned` counts editions where RPC has SEEN a serial under
--     that username (panini_card_serials.owner, matched on lower() like
--     panini_owner_summary). The owner is point-in-time: it is what the walk last
--     read, so a card sold since can still sit under its previous holder, and a
--     card never listed is never seen. The cost then covers only the editions the
--     username has NOT been seen holding.
--
-- Measured before shipping: ~2,600 buffers / ~90 ms for all 62 sets with a
-- username (index-only scan on idx_panini_serials_listed_edition + the
-- lower(owner) index).

CREATE OR REPLACE FUNCTION public.panini_set_progress(p_username text DEFAULT NULL)
RETURNS TABLE (
  set_name text,
  editions_seen integer,
  players_seen integer,
  min_mint_cap integer,
  max_mint_cap integer,
  still_in_packs bigint,
  owned integer,
  missing integer,
  missing_asked integer,
  missing_unasked integer,
  cost_usd numeric,
  owner_last_seen_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH asks AS (
    SELECT s.edition_external_id, min(s.price_usd) AS low_ask
    FROM panini_card_serials s
    WHERE s.is_listed AND s.price_usd > 0 AND s.captured_at > now() - interval '7 days'
    GROUP BY s.edition_external_id
  ), mine AS (
    SELECT s.edition_external_id, max(s.captured_at) AS seen_at
    FROM panini_card_serials s
    WHERE p_username IS NOT NULL AND s.owner <> '' AND lower(s.owner) = lower(p_username)
    GROUP BY s.edition_external_id
  )
  SELECT
    e.set_name,
    count(*)::integer,
    count(DISTINCT e.player_name)::integer,
    min(e.mint_cap)::integer,
    max(e.mint_cap)::integer,
    sum(e.still_in_packs)::bigint,
    count(m.edition_external_id)::integer,
    count(*) FILTER (WHERE m.edition_external_id IS NULL)::integer,
    count(a.low_ask) FILTER (WHERE m.edition_external_id IS NULL)::integer,
    count(*) FILTER (WHERE m.edition_external_id IS NULL AND a.low_ask IS NULL)::integer,
    round(sum(a.low_ask) FILTER (WHERE m.edition_external_id IS NULL), 2),
    max(m.seen_at)
  FROM panini_editions e
  LEFT JOIN asks a ON a.edition_external_id = e.external_id
  LEFT JOIN mine m ON m.edition_external_id = e.external_id
  WHERE e.set_name IS NOT NULL
  GROUP BY e.set_name
  ORDER BY count(*) DESC, e.set_name;
$$;

COMMENT ON FUNCTION public.panini_set_progress(text) IS
  'Panini Sets tab: per set, editions SEEN (listing-gated), cost over confirmed (7 d) asks for editions not seen under p_username. A floor, not a census.';

REVOKE ALL ON FUNCTION public.panini_set_progress(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_set_progress(text) TO service_role;
