-- audit_20260928_panini_serial_state_listed_and_burnt
--
-- WHY. Two defects in panini_card_serials, measured 2026-09-28:
--
--   1. `is_listed` MEANT "EXISTS", NOT "FOR SALE". lib/chains/panini/ingest-normalize.ts set it
--      from Panini's `state === "AVAILABLE"`, but Panini's per-edition card list returns EVERY
--      serial of an edition with state AVAILABLE — held or listed. Only `buy_now_price` marks a
--      listing. 262,331 rows read is_listed=true and 245,355 of them (93.5%) had no price.
--      Every board already required price_usd > 0 (market, deals, set asks, edition "Listed
--      Now"), so they were right; three owner readers were not, so the Collection tab's
--      "Listed now" counted held cards. The writer is fixed in the same commit (listed =
--      AVAILABLE AND priced) and the rows are backfilled in batches after this migration.
--
--   2. BURNT CARDS COUNTED AS HELD. 11,620 serials (715 owners) carry state BURNT with their
--      last owner still on the row, and the owner readers filtered on owner alone — so a
--      collector's burnt cards were "cards seen" under them and filled set progress.
--
-- The state was only in `raw` (jsonb). A plain nullable column (no default -> no table
-- rewrite; a STORED generated column would rewrite all 274k rows under an exclusive lock) is
-- written by the ingest from now on and backfilled from raw->>'state'. The readers exclude
-- 'BURNT' with IS DISTINCT FROM, so an unbackfilled NULL row still counts (fails open to the
-- old behaviour, never drops a live card), and "listed" additionally requires a price.
--
-- anon-exec: intentional — CREATE OR REPLACE keeps the existing ACL (service_role only; verified before) (public.panini_owner_cards)
-- anon-exec: intentional — CREATE OR REPLACE keeps the existing ACL (service_role only; verified before) (public.panini_owner_summary)
-- anon-exec: intentional — CREATE OR REPLACE keeps the existing ACL (service_role only; verified before) (public.panini_set_progress)

ALTER TABLE public.panini_card_serials ADD COLUMN IF NOT EXISTS serial_state text;
COMMENT ON COLUMN public.panini_card_serials.serial_state IS
  'Panini''s serial state as last read (AVAILABLE / BURNT / PROCESSING). AVAILABLE means the serial exists, NOT that it is for sale — a listing is is_listed (AVAILABLE and priced).';

CREATE OR REPLACE FUNCTION public.panini_owner_cards(p_username text, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH mine AS (
    SELECT s.sku, s.edition_external_id, s.serial_number, s.mint_cap,
           (s.is_listed AND s.price_usd > 0) AS is_listed, s.price_usd,
           s.last_sale_usd, s.last_sale_at, s.captured_at,
           s.is_number_one, s.is_jersey_mint, s.is_perfect_mint, s.is_special
    FROM panini_card_serials s
    WHERE p_username IS NOT NULL AND s.owner <> '' AND lower(s.owner) = lower(btrim(p_username))
      AND s.serial_state IS DISTINCT FROM 'BURNT'
  ), priced AS (
    SELECT m.*, pe.player_name, pe.set_name, pe.tier::text AS tier,
           public.panini_asset_url(pe.thumbnail_url) AS thumbnail_url,
           f.fmv_usd, f.confidence::text AS confidence
    FROM mine m
    LEFT JOIN panini_editions pe ON pe.external_id = m.edition_external_id
    LEFT JOIN editions e
      ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b' AND e.external_id = m.edition_external_id
    LEFT JOIN edition_fmv_current f ON f.edition_id = e.id
  )
  SELECT jsonb_build_object(
    'username',         lower(btrim(p_username)),
    'cards_seen',       (SELECT count(*) FROM priced),
    'listed_now',       (SELECT count(*) FROM priced WHERE is_listed),
    'editions',         (SELECT count(DISTINCT edition_external_id) FROM priced),
    'special_serials',  (SELECT count(*) FROM priced WHERE is_special),
    'fmv_seen_usd',     (SELECT round(sum(fmv_usd), 2) FROM priced WHERE fmv_usd > 0),
    'fmv_priced_cards', (SELECT count(*) FROM priced WHERE fmv_usd > 0),
    'last_seen_at',     (SELECT max(captured_at) FROM priced),
    'cards', COALESCE((
      SELECT jsonb_agg(to_jsonb(c.*) ORDER BY c.fmv_usd DESC NULLS LAST, c.sku)
      FROM (
        SELECT sku, edition_external_id, serial_number, mint_cap, is_listed, price_usd AS ask_usd,
               last_sale_usd, last_sale_at, captured_at, is_number_one, is_jersey_mint,
               is_perfect_mint, player_name, set_name, tier, thumbnail_url, fmv_usd, confidence
        FROM priced
        ORDER BY fmv_usd DESC NULLS LAST, sku
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)
      ) c
    ), '[]'::jsonb)
  )
$$;

CREATE OR REPLACE FUNCTION public.panini_owner_summary(p_username text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'username',        lower(p_username),
    'cards_seen',      count(*),
    'listed_now',      count(*) FILTER (WHERE is_listed AND price_usd > 0),
    'special_serials', count(*) FILTER (WHERE is_special),
    'editions',        count(DISTINCT edition_external_id),
    'last_seen_at',    max(captured_at)
  )
  FROM public.panini_card_serials
  WHERE owner <> '' AND lower(owner) = lower(p_username)
    AND serial_state IS DISTINCT FROM 'BURNT';
$$;

CREATE OR REPLACE FUNCTION public.panini_set_progress(p_username text DEFAULT NULL::text)
RETURNS TABLE(set_name text, editions_seen integer, players_seen integer, min_mint_cap integer, max_mint_cap integer, still_in_packs bigint, owned integer, missing integer, missing_asked integer, missing_unasked integer, cost_usd numeric, max_missing_ask_usd numeric, owner_last_seen_at timestamp with time zone)
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
      AND s.serial_state IS DISTINCT FROM 'BURNT'
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
