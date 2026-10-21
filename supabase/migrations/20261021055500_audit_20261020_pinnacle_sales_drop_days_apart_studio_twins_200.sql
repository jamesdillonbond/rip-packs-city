-- audit_20261020_pinnacle_sales_drop_days_apart_studio_twins_200
--
-- 2026-10-20 ~10:55 PM PT (Cowork cloud; register #200, filed 9:49 PM PT by Claude Code; Trevor approved the
-- dashboard-editor DELETE in chat). Applied through the Supabase dashboard SQL editor (the MCP holds DELETE);
-- its schema_migrations row is inserted by hand.
--
-- WHAT. Disney Pinnacle still held studio-history twins of on-chain sales that the 09-28 pass
-- (20260929062127, ±2 days) did not match: the studio feed's date runs up to ~30 days EARLY. Measured live
-- ~10:45 PM PT, per sold_at month then estate-wide (the pair join runs in < 60 s):
--   studio rows (source 'pinnacle_studio_history_v1') joined to non-studio rows on nft_id + exact price +
--   normalised buyer (studio stores it without 0x; empty-buyer pairs: 0):
--     5,826 pairs; 5,820 one-to-one; on-chain row LATER than the studio row in all but 1;
--     gap 2–30 days for 5,804 of them (2–5 d 1,979 · 5–10 d 1,457 · 10–15 d 893 · 15–20 d 603 ·
--     20–25 d 441 · 25–30 d 431), then 7 outliers at 72–258 days — LEFT ALONE here;
--     0 have another sale of the same NFT between the two dates (the #200 falsifier: a buyer who sold and
--     re-bought in between would show one).
--   This file removes exactly those 5,804 studio rows ($112,984 of double-counted volume, 5,773 NFTs,
--   newest studio row 2026-06-24 — so 30-day FMV inputs and Market Pulse never saw them; pin sales lists,
--   90-day/1-year history and all-time Pinnacle volume did).
--
-- KEPT FIRST in pinnacle_sales_studio_twins_20261020 (RLS on). The writer that created them
-- (app/api/cron/pinnacle-studio-sales-history-backfill) now treats a studio row up to 30 days BEFORE a
-- non-studio sale with the SAME known buyer and price as that sale (same commit), so none return.
--
-- GUARDED: the whole block raises (and rolls back) unless 5,700–5,900 rows match, and re-checks that every
-- deleted row was saved. Idempotent: a re-run matches 0 and does nothing.
--
-- REVERT: INSERT INTO public.pinnacle_sales SELECT * FROM public.pinnacle_sales_studio_twins_20261020
--         ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.pinnacle_sales_studio_twins_20261020 (LIKE public.pinnacle_sales INCLUDING DEFAULTS);
ALTER TABLE public.pinnacle_sales_studio_twins_20261020 ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pinnacle_sales_studio_twins_20261020'::regclass AND contype = 'p') THEN
    ALTER TABLE public.pinnacle_sales_studio_twins_20261020 ADD PRIMARY KEY (id);
  END IF;
END $$;
REVOKE ALL ON public.pinnacle_sales_studio_twins_20261020 FROM PUBLIC, anon, authenticated;

DO $mig$
DECLARE
  v_match   int;
  v_saved   int;
  v_deleted int;
BEGIN
  SET LOCAL statement_timeout = '300s';

  CREATE TEMP TABLE _twins ON COMMIT DROP AS
  WITH h AS (
    SELECT id, nft_id, sale_price_usd AS p, sold_at,
           lower(regexp_replace(COALESCE(buyer_address::text, ''), '^0x', '')) AS b
      FROM public.pinnacle_sales
     WHERE source = 'pinnacle_studio_history_v1'
  ),
  pairs AS (
    SELECT h.id AS hid, o.id AS oid, h.sold_at AS hs, o.sold_at AS os, h.nft_id, h.b
      FROM h
      JOIN public.pinnacle_sales o
        ON o.nft_id = h.nft_id
       AND o.source <> 'pinnacle_studio_history_v1'
       AND o.sale_price_usd = h.p
       AND lower(regexp_replace(COALESCE(o.buyer_address::text, ''), '^0x', '')) = h.b
  ),
  counted AS (
    SELECT *, count(*) OVER (PARTITION BY hid) AS n_h, count(*) OVER (PARTITION BY oid) AS n_o FROM pairs
  )
  SELECT c.hid
    FROM counted c
   WHERE c.n_h = 1 AND c.n_o = 1
     AND c.b <> ''
     AND c.os > c.hs AND c.os <= c.hs + interval '30 days'
     AND NOT EXISTS (SELECT 1 FROM public.pinnacle_sales x
                      WHERE x.nft_id = c.nft_id AND x.id NOT IN (c.hid, c.oid)
                        AND x.sold_at > c.hs AND x.sold_at < c.os);

  SELECT count(*) INTO v_match FROM _twins;
  IF v_match = 0 THEN
    RAISE NOTICE 'no days-apart studio twins left — no-op';
    RETURN;
  END IF;
  IF v_match NOT BETWEEN 5700 AND 5900 THEN
    RAISE EXCEPTION 'expected ~5,804 days-apart studio twins, matched % — re-measure before deleting', v_match;
  END IF;

  INSERT INTO public.pinnacle_sales_studio_twins_20261020
  SELECT s.* FROM public.pinnacle_sales s JOIN _twins t ON t.hid = s.id
  ON CONFLICT (id) DO NOTHING;

  SELECT count(*) INTO v_saved
    FROM _twins t JOIN public.pinnacle_sales_studio_twins_20261020 b ON b.id = t.hid;
  IF v_saved <> v_match THEN
    RAISE EXCEPTION 'backup holds % of % rows — refusing to delete', v_saved, v_match;
  END IF;

  DELETE FROM public.pinnacle_sales s USING _twins t WHERE s.id = t.hid;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_match THEN
    RAISE EXCEPTION 'deleted % of % matched rows', v_deleted, v_match;
  END IF;
  RAISE NOTICE 'removed % days-apart studio twins (backed up in pinnacle_sales_studio_twins_20261020)', v_deleted;
END
$mig$;
