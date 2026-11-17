-- 2026-09-29: restore edition_key + serial on 50 All Day wallet_moments_cache rows left key-less by a NULL upsert.
-- Wallet 0x40d8e33333d73e40: the rows carry a walker-filled name, image and FMV but NULL edition_key and
-- serial_number; their last touch (last_seen_at, 12:12 PM PT 09-27) most likely wrote the NULLs — the
-- upsert_wmc_batch "NULL overwrites a known value" defect, fixed the same day in 20260929203000_audit_20260929_upsert_wmc_batch_null_never_erases_a_known_key.
-- Values are a mainnet read of each NFT on 2026-09-29 (AllDay.NFT.editionID / serialNumber, borrowed from the
-- wallet's own collection); every edition matches the row's image_url edition. Guarded: still NULL-keyed, the
-- edition exists in the catalog, the serial fits its circulation. Prior state copied first.
-- Not touched: 7 older All Day NULL rows (May) that read absent on chain — for All Day a LOCKED moment is
-- off-chain in custody, so absence is not evidence the wallet sold it.
-- Revert: UPDATE public.wallet_moments_cache w SET edition_key = a.edition_key, serial_number = a.serial_number
--         FROM public.audit_20260929_allday_wmc_wiped_keys_restored a WHERE w.id = a.id;
CREATE TABLE IF NOT EXISTS public.audit_20260929_allday_wmc_wiped_keys_restored AS
  SELECT * FROM public.wallet_moments_cache WITH NO DATA;
ALTER TABLE public.audit_20260929_allday_wmc_wiped_keys_restored ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260929_allday_wmc_wiped_keys_restored FROM PUBLIC, anon, authenticated;

WITH chain(moment_id, edition_key, serial_number) AS (VALUES
  ('1048781', '556', 6106),
  ('1054231', '557', 1556),
  ('1339040', '614', 7134),
  ('1554986', '636', 3080),
  ('1698424', '684', 5792),
  ('1785720', '693', 3308),
  ('1863080', '701', 668),
  ('1928266', '721', 4827),
  ('1989940', '745', 3338),
  ('1992395', '745', 5793),
  ('2004659', '747', 1177),
  ('2028527', '749', 7925),
  ('2057981', '753', 3819),
  ('2090715', '757', 2553),
  ('2112695', '759', 7753),
  ('2162249', '776', 4323),
  ('2244562', '786', 2876),
  ('2246235', '786', 4549),
  ('2247057', '786', 5371),
  ('2247623', '786', 5937),
  ('2248033', '786', 6347),
  ('2257157', '786', 6971),
  ('23252', '355', 2900),
  ('2341099', '812', 9281),
  ('2345764', '813', 3946),
  ('2456731', '830', 3202),
  ('2469005', '831', 6476),
  ('2471561', '832', 32),
  ('2487488', '833', 6959),
  ('2506324', '835', 7795),
  ('2523303', '837', 6774),
  ('2578649', '843', 8340),
  ('2578790', '843', 8481),
  ('2637520', '854', 2211),
  ('2639040', '854', 3731),
  ('2644866', '855', 2557),
  ('2645666', '855', 3357),
  ('2645667', '855', 3358),
  ('2646310', '855', 4001),
  ('2652401', '856', 3092),
  ('2674081', '869', 664),
  ('29000', '355', 8648),
  ('3086259', '970', 9657),
  ('3153127', '984', 6751),
  ('320590', '398', 889),
  ('32088', '356', 1736),
  ('32623', '356', 2271),
  ('36001', '356', 5649),
  ('4371', '353', 4019),
  ('768041', '499', 6587)
),
target AS (
  SELECT w.id, c.edition_key, c.serial_number
  FROM public.wallet_moments_cache w
  JOIN chain c ON c.moment_id = w.moment_id
  JOIN public.editions e ON e.collection_id = w.collection_id AND e.external_id = c.edition_key
  WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    AND w.wallet_address = '0x40d8e33333d73e40'
    AND w.edition_key IS NULL
    AND (e.circulation_count IS NULL OR c.serial_number <= e.circulation_count)
),
saved AS (
  INSERT INTO public.audit_20260929_allday_wmc_wiped_keys_restored
  SELECT w.* FROM public.wallet_moments_cache w JOIN target t ON t.id = w.id
  RETURNING id
)
UPDATE public.wallet_moments_cache w
   SET edition_key = t.edition_key, serial_number = t.serial_number
  FROM target t
 WHERE w.id = t.id AND w.id IN (SELECT id FROM saved);