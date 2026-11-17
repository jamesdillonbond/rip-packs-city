-- 2026-09-29 (#159 follow-up; Trevor: "Do what you think is best"): the 09-28
-- cleanup kept 9 studio-history rows it could not pair one-to-one. Read one by one:
--   * 7 have a DIFFERENT buyer from their on-chain match: real resales of the
--     same pin at the same price within 2 days. They stay.
--   * 2 are one wallet (0x23dde701491082ad) buying nft 163827235222471 twice on
--     06-24 at $2: two real sales, each with its own studio twin (nearest-time
--     pairing: studio 00:50 <-> on-chain 01:40, studio 03:26 <-> on-chain 03:38).
--     Both studio twins are removed here, backed up first like the 25,793.
-- Revert: INSERT INTO public.pinnacle_sales SELECT * FROM public.pinnacle_sales_studio_twins_20260928
--         WHERE id LIKE '%\_163827235222471';

WITH saved AS (
  INSERT INTO public.pinnacle_sales_studio_twins_20260928
  SELECT s.* FROM public.pinnacle_sales s
  WHERE s.source = 'pinnacle_studio_history_v1'
    AND s.id IN ('ab36771a1c5e230595d6a4ea23be5a70c0329c702e267fedb99ba50900ea1dec_163827235222471',
                 'a71e967de82f96c3c73a4c36e5a6e9dedb78223cfdf53d3dec8b962441ca40e5_163827235222471')
  ON CONFLICT DO NOTHING
  RETURNING id
)
DELETE FROM public.pinnacle_sales s USING saved WHERE s.id = saved.id;
