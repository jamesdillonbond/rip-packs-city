-- 2026-10-20 ~11:10 PM PT (Claude Code cloud) — known-issues #200: Disney Pinnacle still holds
-- studio-history twins of on-chain sales, DAYS apart, which the 09-28 cleanup (20260929062127,
-- a ±2-day window) did not match. FOR TREVOR: paste into the dashboard SQL editor and Run
-- (it DELETEs, which the MCP holds for a human). One statement after the backup table; every
-- deleted row is copied to pinnacle_sales_studio_twins_20261020 first.
--
-- MEASURED 10-20 ~11:05 PM PT (bounded indexed join, ~1 s). Studio rows
-- (source 'pinnacle_studio_history_v1', buyer non-empty) matched to an on-chain row of the SAME
-- nft_id, price and buyer (0x-normalised): 5,826 pairs, 5,820 one-to-one both ways. Gap
-- (on-chain minus studio), one-to-one pairs:
--     2–10 d  3,436   10–20 d  1,497   20–30 d  872   40–259 d  15   negative  1
-- The studio row is ALWAYS the earlier one, and inside 0–31 d only 1 pair has any other sale of
-- that NFT between the two rows. That is the twin signature (the studio feed's dates run days
-- early; the ownership chain shows ONE purchase, e.g. LEV1-EP4S-REBE-S6 #201).
--
-- RULE (deliberately narrower than "one-to-one, any gap"): one-to-one both ways, on-chain row
-- 0–31 days AFTER the studio row, and NO other pinnacle_sales row for that NFT between them (a
-- sale in between means the buyer sold and re-bought: two real purchases). Measured in-rule:
-- 5,804 rows, $112,984 of double-counted volume, 5,773 NFTs. The 16 outliers and the 6 many-to-one rows stay.
-- None in the last 30 days (newest studio row 2026-06-24), so 30-day FMV inputs and Market
-- Pulse do not move; pin sales lists, 90-day/1-year history and all-time volume do.
--
-- After: re-run the measurement below; it should return ~0 in-rule pairs. The pin page's
-- read-side dedupe (dedupeStudioTwinSales, lib/pinnacle/moment-detail.ts) can stay; it becomes
-- a no-op on these rows.
--
-- REVERT: INSERT INTO public.pinnacle_sales SELECT * FROM public.pinnacle_sales_studio_twins_20261020;

CREATE TABLE IF NOT EXISTS public.pinnacle_sales_studio_twins_20261020 (LIKE public.pinnacle_sales INCLUDING DEFAULTS);
ALTER TABLE public.pinnacle_sales_studio_twins_20261020 ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pinnacle_sales_studio_twins_20261020'::regclass AND contype = 'p') THEN
    ALTER TABLE public.pinnacle_sales_studio_twins_20261020 ADD PRIMARY KEY (id);
  END IF;
END $$;
REVOKE ALL ON public.pinnacle_sales_studio_twins_20261020 FROM PUBLIC, anon, authenticated;

WITH pairs AS (
  SELECT h.id AS hid, o.id AS oid, h.nft_id, h.sold_at AS h_at, o.sold_at AS o_at
  FROM public.pinnacle_sales h
  JOIN public.pinnacle_sales o
    ON o.nft_id = h.nft_id
   AND o.source <> 'pinnacle_studio_history_v1'
   AND o.sale_price_usd = h.sale_price_usd
   AND lower(regexp_replace(COALESCE(o.buyer_address::text, ''), '^0x', ''))
     = lower(regexp_replace(COALESCE(h.buyer_address::text, ''), '^0x', ''))
  WHERE h.source = 'pinnacle_studio_history_v1'
    AND COALESCE(h.buyer_address, '') <> ''
),
counted AS (
  SELECT *, count(*) OVER (PARTITION BY hid) AS n_h, count(*) OVER (PARTITION BY oid) AS n_o
  FROM pairs
),
twins AS (
  SELECT c.hid FROM counted c
   WHERE c.n_h = 1 AND c.n_o = 1
     AND c.o_at >= c.h_at AND c.o_at <= c.h_at + interval '31 days'
     AND NOT EXISTS (
           SELECT 1 FROM public.pinnacle_sales x
            WHERE x.nft_id = c.nft_id
              AND x.sold_at > c.h_at AND x.sold_at < c.o_at)
),
saved AS (
  INSERT INTO public.pinnacle_sales_studio_twins_20261020
  SELECT s.* FROM public.pinnacle_sales s JOIN twins t ON t.hid = s.id
  ON CONFLICT DO NOTHING
  RETURNING id
)
DELETE FROM public.pinnacle_sales s
USING saved
WHERE s.id = saved.id;

-- Check (expect 5,804 in the backup, and ~0 in-rule pairs left):
--   SELECT count(*), round(sum(sale_price_usd)) FROM public.pinnacle_sales_studio_twins_20261020;
