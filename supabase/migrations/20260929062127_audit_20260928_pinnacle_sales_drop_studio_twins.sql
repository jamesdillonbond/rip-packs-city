-- 2026-09-28 page audit (#22): 25,802 pinnacle_sales rows from the studio
-- history backfill (source 'pinnacle_studio_history_v1', all sold before
-- 2026-06-26) duplicate a sale the on-chain feeds already hold: same nft_id,
-- same price, same buyer (the studio feed stores it without 0x), a median of
-- 0.34 h apart. The writer deduped on id = `${tx}_${nft}`, but the studio
-- feed's tx hash and time are not the on-chain sale's, so each twin arrived
-- under a new id and $617k of volume across 2,033 pins was counted twice.
--
-- Removes only the UNAMBIGUOUS twins: a studio row matched to exactly one
-- on-chain row, and that row to exactly one studio row (25,793 at authoring;
-- 9 many-to-one rows stay). Every deleted row is kept first in
-- pinnacle_sales_studio_twins_20260928. The writer now skips a twin
-- (app/api/cron/pinnacle-studio-sales-history-backfill), so none return.
--
-- Revert: INSERT INTO public.pinnacle_sales SELECT * FROM public.pinnacle_sales_studio_twins_20260928;

CREATE TABLE IF NOT EXISTS public.pinnacle_sales_studio_twins_20260928 (LIKE public.pinnacle_sales INCLUDING DEFAULTS);
ALTER TABLE public.pinnacle_sales_studio_twins_20260928 ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pinnacle_sales_studio_twins_20260928'::regclass AND contype = 'p') THEN
    ALTER TABLE public.pinnacle_sales_studio_twins_20260928 ADD PRIMARY KEY (id);
  END IF;
END $$;
REVOKE ALL ON public.pinnacle_sales_studio_twins_20260928 FROM PUBLIC, anon, authenticated;

WITH pairs AS (
  SELECT h.id AS hid, o.id AS oid
  FROM public.pinnacle_sales h
  JOIN public.pinnacle_sales o
    ON o.nft_id = h.nft_id
   AND o.source <> 'pinnacle_studio_history_v1'
   AND o.sale_price_usd = h.sale_price_usd
   AND o.sold_at BETWEEN h.sold_at - interval '2 days' AND h.sold_at + interval '2 days'
   AND lower(regexp_replace(COALESCE(o.buyer_address::text, ''), '^0x', ''))
     = lower(regexp_replace(COALESCE(h.buyer_address::text, ''), '^0x', ''))
  WHERE h.source = 'pinnacle_studio_history_v1'
),
counted AS (
  SELECT hid,
         count(*) OVER (PARTITION BY hid) AS n_h,
         count(*) OVER (PARTITION BY oid) AS n_o
  FROM pairs
),
one_to_one AS (
  SELECT hid FROM counted WHERE n_h = 1 AND n_o = 1
),
saved AS (
  INSERT INTO public.pinnacle_sales_studio_twins_20260928
  SELECT s.* FROM public.pinnacle_sales s JOIN one_to_one t ON t.hid = s.id
  ON CONFLICT DO NOTHING
  RETURNING id
)
DELETE FROM public.pinnacle_sales s
USING saved
WHERE s.id = saved.id;
