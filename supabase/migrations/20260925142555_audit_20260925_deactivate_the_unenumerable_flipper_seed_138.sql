-- 2026-09-25 (PT) — #138 decision. Two seeded Top Shot wallets hold more
-- moments than one Cadence script can enumerate on the public access node
-- (computation limit 1110; offset paging is O(N^2), measured 09-25). No id source
-- exists today: topshot_ownership holds 417 / 2,030 rows for them, last observed
-- 08-11 / 07-20.
--
-- (a) 0x0d744d23165bfb6c (seeded_wallets.id 375) — an AUTO-DISCOVERED "active
--     flipper" ($21 volume / 63 txns in 90 d) the walker can never finish.
--     Deactivated: is_active gates only the seed-wallet-refresh selection and the
--     /api/seeded-wallets listing (read 09-25). Its 158,669 wallet_moments_cache
--     rows are left as they are (nothing user-facing reads this wallet).
-- (b) TopShot_Buyback_2 0xe1f2a091f7bb5245 (id 61) STAYS ACTIVE: it is a
--     signal_source whose analytics read its SALES (app/api/analytics/buyback),
--     not its holdings, and the walker already records its limit as ok=true /
--     computation_limit_exceeded (shipped 09-25), so it no longer reads as failure.
-- Building a mega-wallet id source (a higher-limit access node, an indexer, or
-- deposit/withdraw events) is deferred until a collector's wallet needs it.
-- Revert: UPDATE seeded_wallets SET is_active = true WHERE id = 375;

DO $$
DECLARE n int;
BEGIN
  UPDATE public.seeded_wallets
     SET is_active = false,
         notes = coalesce(notes, '') || ' | 2026-09-25: deactivated (#138) — holds ~158k moments, beyond one Cadence script on the public access node; the walker can never finish it.',
         updated_at = now()
   WHERE id = 375 AND wallet_address = '0x0d744d23165bfb6c' AND is_active;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected to deactivate exactly one row, got %', n; END IF;
END $$;
