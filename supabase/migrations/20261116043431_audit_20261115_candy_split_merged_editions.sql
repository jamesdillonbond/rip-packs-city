-- audit_20261115_candy_split_merged_editions
--
-- #259 (2026-11-15 ~8:30 PM PT, Claude Code cloud; Trevor: "you need to handle 2026-11-16T0404Z first").
-- 90 Candy editions held DIFFERENT cards (42,592 holdings; 3,857 with a serial above the edition's
-- circulation) plus 9 date-bug buckets ("MLB Play of the Day 10/"). The code side
-- (lib/chains/solana/candy-split-editions.ts, normalize.ts, collections-census.ts) re-reads each card of
-- those editions ONCE from its own metadata and re-keys it; this migration adds what the census needs:
--
--   (1) candy_edition_split_checked — the cards already re-read (so the census never fetches one twice
--       for this reason). Service role only.
--   (2) candy_sales_rekey_log — every sale moved by (3): sale id, sold_at, old and new edition. Revert key.
--   (3) candy_repoint_sales_to_card_edition(p_mints) — a Candy SALE follows its CARD: every sales row for
--       a token mint moves to the edition the card's NEWEST holdings row names (twin of
--       candy_repoint_listings_to_card_edition / candy_repoint_offers_to_card_edition). Logged first.
--       A mint with no holdings row is never guessed. Returns rows moved.
--
-- PIN: supabase/tests/candy_repoint_sales_to_card_edition.sql
-- REVERT:
--   UPDATE public.sales s SET edition_id = l.old_edition_id FROM public.candy_sales_rekey_log l
--    WHERE s.id = l.sale_id AND s.sold_at = l.sold_at AND s.edition_id = l.new_edition_id;
--   DROP FUNCTION public.candy_repoint_sales_to_card_edition(text[]);
--   (the two tables are harmless to keep; drop them only after the revert UPDATE)

CREATE TABLE IF NOT EXISTS public.candy_edition_split_checked (
  moment_id  text        PRIMARY KEY,
  result_key text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.candy_edition_split_checked ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_edition_split_checked FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.candy_edition_split_checked TO service_role;

CREATE TABLE IF NOT EXISTS public.candy_sales_rekey_log (
  sale_id        uuid        NOT NULL,
  sold_at        timestamptz NOT NULL,
  nft_id         text        NOT NULL,
  old_edition_id uuid,
  new_edition_id uuid        NOT NULL,
  rekeyed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candy_sales_rekey_log_at ON public.candy_sales_rekey_log (rekeyed_at);
ALTER TABLE public.candy_sales_rekey_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_sales_rekey_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.candy_repoint_sales_to_card_edition(p_mints text[])
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- A Candy SALE follows its CARD (#259, 2026-11-15; twin of candy_repoint_listings_to_card_edition):
  -- when the census repoints a card off an edition that merged different cards, every sales row for that
  -- token mint moves to the edition the card's NEWEST holdings row names, so a merged edition's price and
  -- FMV stop carrying another card's sales. Each move is logged to candy_sales_rekey_log first (revert).
  -- A mint with no holdings row is never guessed. Returns rows moved.
  WITH cur AS (
    SELECT DISTINCT ON (w.moment_id) w.moment_id, e.id AS edition_id
      FROM public.wallet_moments_cache w
      JOIN public.editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
     WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
       AND w.moment_id = ANY (p_mints)
     ORDER BY w.moment_id, w.last_seen_at DESC NULLS LAST
  ), mv AS (
    SELECT s.id, s.sold_at, s.nft_id, s.edition_id AS old_id, cur.edition_id AS new_id
      FROM public.sales s
      JOIN cur ON s.nft_id = cur.moment_id
     WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
       AND s.edition_id IS DISTINCT FROM cur.edition_id
  ), logged AS (
    INSERT INTO public.candy_sales_rekey_log (sale_id, sold_at, nft_id, old_edition_id, new_edition_id)
    SELECT id, sold_at, nft_id, old_id, new_id FROM mv
    RETURNING sale_id, sold_at, old_edition_id, new_edition_id
  ), moved AS (
    UPDATE public.sales s
       SET edition_id = l.new_edition_id
      FROM logged l
     WHERE s.id = l.sale_id AND s.sold_at = l.sold_at
       AND s.edition_id IS NOT DISTINCT FROM l.old_edition_id
    RETURNING 1
  )
  SELECT count(*)::int FROM moved
$function$;

REVOKE EXECUTE ON FUNCTION public.candy_repoint_sales_to_card_edition(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_repoint_sales_to_card_edition(text[]) TO service_role;
