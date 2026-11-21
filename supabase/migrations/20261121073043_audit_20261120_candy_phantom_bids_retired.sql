-- audit_20261120_candy_phantom_bids_retired
--
-- 2026-11-20 ~11:25 PM PT (Claude Code cloud). Trevor, asked "reply 'yes, retire the bids' and I'll remove them":
-- "Do what you think is best" — Claude Code's recommendation was to retire them.
--
-- WHY: all 4 active candy_offers rows belong to one bidder, GFGmpV5zJaF4enTZNLGbavHXCDiKorfDQCsRg8ZEjapg — last Candy
-- trade 10-10 (before the 10-12 lock), no purchase since trading reopened, 0 cards held. Cowork checked on chain
-- (inbox 2026-11-21T0315Z item 3): wallet balance 0.00089 SOL against ~1.5 SOL of bids, and the Magic Eden V2 escrow
-- PDA (seeds ["m2", buyer]) does not exist — the bids cannot fill. Magic Eden still serves them (the same behaviour as
-- the 9.4k phantom asks retired at 7:35 PM PT). They fed the "best bid" line of 3 editions' market-history charts.
--
-- STICKINESS: /api/ingest/candy-offers re-upserts served offers as active, but only for bidders it discovers — from
-- recent bid activity or from the ACTIVE book. This bidder has no activity since 10-10, so once inactive it is not
-- swept. Falsifier: any of the 4 pda_addresses below is_active again after the 2:50 AM PT 11-21 sweep.
--
-- REVERT:
--   UPDATE public.candy_offers SET is_active = true
--    WHERE pda_address IN ('3iMTiDwmouW4QHYZJ8orb8e6FbFfFXbzttMjbDivSkxs','7iAVo3emUQNtwkZdau7bpCUS1VuZ8DhPxUshiH5Vj6DF',
--                          'BJrmQSoSwg8DoJpdGR9qxF4hXWiJkEpVvTyc2Jj7tk9c','F4xMyTyCvKC1jQUhEHqedT12BWWZXT7kMSFP4wJGJCYc');

DO $mig$
DECLARE n int;
BEGIN
  UPDATE public.candy_offers
     SET is_active = false
   WHERE is_active
     AND buyer = 'GFGmpV5zJaF4enTZNLGbavHXCDiKorfDQCsRg8ZEjapg'
     AND pda_address IN ('3iMTiDwmouW4QHYZJ8orb8e6FbFfFXbzttMjbDivSkxs','7iAVo3emUQNtwkZdau7bpCUS1VuZ8DhPxUshiH5Vj6DF',
                         'BJrmQSoSwg8DoJpdGR9qxF4hXWiJkEpVvTyc2Jj7tk9c','F4xMyTyCvKC1jQUhEHqedT12BWWZXT7kMSFP4wJGJCYc');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected to retire exactly 4 bids, matched %', n;
  END IF;
END
$mig$;
