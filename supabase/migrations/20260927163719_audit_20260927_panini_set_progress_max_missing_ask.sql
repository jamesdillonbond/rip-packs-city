-- audit_20260927_panini_set_progress_max_missing_ask
--
-- Adds `max_missing_ask_usd` to panini_set_progress (20260927163619, same day,
-- no caller shipped yet). The cost to finish a Panini set is the sum of today's
-- lowest confirmed asks, and it is CONCENTRATED: measured 2026-09-27, the top
-- holder's Base Prizms Gold cost read $185,000 for 2 missing editions, $100,000
-- of it one Messi /10 ask with no FMV. That ask is real (it is what the card costs
-- to buy today), so it is not capped — but a total with no breakdown invites the
-- reading "every missing card is expensive". The Sets tab names the largest single
-- ask beside the total. The return type changes, so DROP first (42P13 otherwise).

DROP FUNCTION IF EXISTS public.panini_set_progress(text);

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
  max_missing_ask_usd numeric,
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
    max(a.low_ask) FILTER (WHERE m.edition_external_id IS NULL),
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
