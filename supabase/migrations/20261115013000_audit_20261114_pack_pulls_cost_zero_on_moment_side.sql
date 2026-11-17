-- 2026-11-14 (~5:25 PM PT, Cowork cloud). Trevor (5:19 PM PT): "The cost of the packs- both via usd and trade ticket,
-- should only live on the packs side of things. Moments pulled from packs should show a $0 cost in the moment P&L side
-- of things since that cost should be recorded on the opened packs side of things."
--
-- So a moment_acquisitions row with acquisition_method = 'pack_pull' carries buy_price 0, never a share of the pack.
--  (1) Trigger: a pack_pull row written with buy_price NULL (every pack-pull writer does that) is stored as 0, so new
--      rows land right without touching each writer. An explicit non-NULL price is left alone.
--  (2) The 251 pack-pull rows that carried a share of a pack price (all 0xbd94cade097e50ac, written earlier tonight by
--      20261115000235 and 20261115010000: $1,735.07 USD packs + $9.30 Trade Ticket packs) -> 0. The per-pack
--      prices stay where they belong, on the pack: get_wallet_pack_history; the split we computed stays archived in
--      flowty_archive.nft_pack_pull_prices_20261114 / flowty_archive.pack_pull_reward_ticket_cost_20261114.
--  (3) The ~1.16M existing pack_pull rows with buy_price NULL are set to 0 by a batched backfill run separately
--      (execute_sql, 100k rows per statement, WHERE acquisition_method='pack_pull' AND buy_price IS NULL) — not here,
--      so this migration stays short.
-- Backup of (2): flowty_archive.moment_acquisitions_bak_pack_pull_zero_20261114.
-- Revert: DROP TRIGGER trg_moment_acq_pack_pull_zero_cost ON moment_acquisitions;
--         DROP FUNCTION public.moment_acq_pack_pull_zero_cost();
--         UPDATE moment_acquisitions m SET buy_price=b.buy_price FROM flowty_archive.moment_acquisitions_bak_pack_pull_zero_20261114 b WHERE m.id=b.id;
--         (the backfill's NULL -> 0 is reverted by UPDATE moment_acquisitions SET buy_price=NULL
--          WHERE acquisition_method='pack_pull' AND buy_price=0 AND source NOT IN ('reward_pack_zero') — rows written 0 on purpose were only those.)

CREATE OR REPLACE FUNCTION public.moment_acq_pack_pull_zero_cost()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  -- Pack cost lives on the pack (get_wallet_pack_history), so a pulled moment's own cost is $0.
  IF NEW.acquisition_method = 'pack_pull' AND NEW.buy_price IS NULL THEN
    NEW.buy_price := 0;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.moment_acq_pack_pull_zero_cost() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_moment_acq_pack_pull_zero_cost ON public.moment_acquisitions;
CREATE TRIGGER trg_moment_acq_pack_pull_zero_cost
  BEFORE INSERT OR UPDATE OF acquisition_method, buy_price ON public.moment_acquisitions
  FOR EACH ROW EXECUTE FUNCTION public.moment_acq_pack_pull_zero_cost();

CREATE TABLE IF NOT EXISTS flowty_archive.moment_acquisitions_bak_pack_pull_zero_20261114 AS
SELECT * FROM moment_acquisitions WHERE acquisition_method = 'pack_pull' AND buy_price > 0;
REVOKE ALL ON flowty_archive.moment_acquisitions_bak_pack_pull_zero_20261114 FROM PUBLIC, anon, authenticated;

UPDATE moment_acquisitions m SET buy_price = 0
FROM flowty_archive.moment_acquisitions_bak_pack_pull_zero_20261114 b WHERE b.id = m.id;

DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM flowty_archive.moment_acquisitions_bak_pack_pull_zero_20261114;
  IF n <> 251 THEN RAISE EXCEPTION 'pack-pull zero: expected 251 priced pack pulls, found %', n; END IF;
END $$;
