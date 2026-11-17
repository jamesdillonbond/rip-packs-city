-- DB invariant: public.candy_repoint_sales_to_card_edition(text[]) — 2026-11-15 (#259).
-- The property: a Candy SALE follows its CARD — every sales row for a given token mint moves to the edition
-- the card's NEWEST holdings row names, and every move is logged (old and new edition) for revert; a sale
-- already on that edition, a mint not asked about, another collection's sale and a mint with no holdings
-- row are untouched; the return value counts rows actually moved; a second call moves nothing.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261116043431_audit_20261115_candy_split_merged_editions.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.wallet_moments_cache (wallet_address text, collection_id uuid, moment_id text, edition_key text, last_seen_at timestamptz);
CREATE TABLE public.sales (id uuid, sold_at timestamptz, nft_id varchar, edition_id uuid, collection_id uuid, PRIMARY KEY (id, sold_at));
CREATE TABLE public.candy_sales_rekey_log (sale_id uuid NOT NULL, sold_at timestamptz NOT NULL, nft_id text NOT NULL, old_edition_id uuid, new_edition_id uuid NOT NULL, rekeyed_at timestamptz NOT NULL DEFAULT now());

-- >>> BEGIN verbatim candy_repoint_sales_to_card_edition (keep byte-identical to the migration) >>>
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
-- <<< END verbatim candy_repoint_sales_to_card_edition <<<

\set CANDY '''209ade70-32c5-4470-bc7c-4793d660f713'''
\set TS    '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000a1', :CANDY::uuid, 'c:batman-1940-2011-1:batman-1940-2011-uncommon'), -- merged (old)
  ('00000000-0000-0000-0000-0000000000a2', :CANDY::uuid, 'c:batman-1940-2011-1:batman-1940-2011-core'),     -- real (new)
  ('00000000-0000-0000-0000-0000000000a3', :CANDY::uuid, 'c:x:josh-core'),
  ('00000000-0000-0000-0000-0000000000a4', :CANDY::uuid, 'c:x:stale-owner-key');
INSERT INTO public.wallet_moments_cache VALUES
  ('W1', :CANDY::uuid, 'mint-1', 'c:batman-1940-2011-1:batman-1940-2011-core', now()),   -- card repointed
  ('W0', :CANDY::uuid, 'mint-1', 'c:x:stale-owner-key', now() - interval '2 days'),       -- older owner row: ignored
  ('W2', :CANDY::uuid, 'mint-2', 'c:x:josh-core', now());                                 -- already in step
INSERT INTO public.sales VALUES
  ('00000000-0000-0000-0000-00000000000a', '2025-08-01', 'mint-1', '00000000-0000-0000-0000-0000000000a1', :CANDY::uuid), -- on the merged edition -> MOVED
  ('00000000-0000-0000-0000-00000000000b', '2026-01-02', 'mint-1', NULL,                                   :CANDY::uuid), -- unlinked             -> MOVED
  ('00000000-0000-0000-0000-00000000000c', '2026-02-03', 'mint-2', '00000000-0000-0000-0000-0000000000a3', :CANDY::uuid), -- in step              -> untouched
  ('00000000-0000-0000-0000-00000000000d', '2026-02-04', 'mint-3', '00000000-0000-0000-0000-0000000000a1', :CANDY::uuid), -- no holdings row      -> untouched
  ('00000000-0000-0000-0000-00000000000e', '2026-02-05', 'mint-9', '00000000-0000-0000-0000-0000000000a1', :CANDY::uuid), -- not asked about      -> untouched
  ('00000000-0000-0000-0000-00000000000f', '2026-02-06', 'mint-1', '00000000-0000-0000-0000-0000000000a1', :TS::uuid);    -- another collection   -> untouched

DO $$
DECLARE n int;
BEGIN
  n := public.candy_repoint_sales_to_card_edition(ARRAY['mint-1', 'mint-2', 'mint-3']);
  PERFORM _assert_eq(n::text, '2', 'exactly the two sales of the repointed card moved');
  PERFORM _assert((SELECT bool_and(edition_id = '00000000-0000-0000-0000-0000000000a2') FROM public.sales WHERE id IN ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')),
                  '⚠ a card''s sales move to the edition its NEWEST holdings row names');
  PERFORM _assert_eq((SELECT count(*) FROM public.candy_sales_rekey_log)::text, '2', 'every move is logged');
  PERFORM _assert((SELECT old_edition_id = '00000000-0000-0000-0000-0000000000a1' AND new_edition_id = '00000000-0000-0000-0000-0000000000a2'
                     FROM public.candy_sales_rekey_log WHERE sale_id = '00000000-0000-0000-0000-00000000000a'), 'the log carries the old and new edition (revert key)');
  PERFORM _assert((SELECT edition_id = '00000000-0000-0000-0000-0000000000a3' FROM public.sales WHERE id = '00000000-0000-0000-0000-00000000000c'), 'an in-step sale is untouched');
  PERFORM _assert((SELECT edition_id = '00000000-0000-0000-0000-0000000000a1' FROM public.sales WHERE id = '00000000-0000-0000-0000-00000000000d'), 'a mint with no holdings row is untouched (never guessed)');
  PERFORM _assert((SELECT edition_id = '00000000-0000-0000-0000-0000000000a1' FROM public.sales WHERE id = '00000000-0000-0000-0000-00000000000e'), 'a mint not asked about is untouched');
  PERFORM _assert((SELECT edition_id = '00000000-0000-0000-0000-0000000000a1' FROM public.sales WHERE id = '00000000-0000-0000-0000-00000000000f'), 'another collection''s sale is untouched');
  n := public.candy_repoint_sales_to_card_edition(ARRAY['mint-1']);
  PERFORM _assert_eq(n::text, '0', 'a second call moves nothing');
  PERFORM _assert_eq((SELECT count(*) FROM public.candy_sales_rekey_log)::text, '2', 'a second call logs nothing');
END $$;

ROLLBACK;
