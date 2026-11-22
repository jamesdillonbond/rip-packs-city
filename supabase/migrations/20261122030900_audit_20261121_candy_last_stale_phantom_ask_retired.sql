-- audit_20261121_candy_last_stale_phantom_ask_retired
--
-- 2026-11-21 ~7:10 PM PT (Claude Code cloud). Trevor, asked whether to retire this one ask: "Do what you think is
-- best" — the recommendation was to retire it.
--
-- WHY: the one active Magic Eden Candy ask unseen > 3 days (known-issues #257): pda CFGipvw9…, Blackest Night
-- (2009-2010) #1, $72.76, last seen 2026-11-15 1:51 PM PT. Seller 9wzMob… made 21 Candy sales before the 10-12 lock,
-- none since, holds 0 cards. Its card has NO holder row anywhere after clean census walks of its collection (burnt or
-- not a card), so neither arm of candy_retire_listings_owner_moved (both join a holder row) can reach it. A general
-- "no holder row → retire" rule was rejected: it would flap real escrow-held listings (#145). No writer re-activates
-- this row (unresolved asks are never upserted); owner_moved_at is stamped too, so both sweeps skip the pda, and the
-- existing clear path lifts the mark if the seller is ever seen holding the card again.
--
-- REVERT:
--   UPDATE public.candy_listings SET is_active = true, owner_moved_at = NULL
--    WHERE pda_address = 'CFGipvw9iq69QEpdr3yiNjvYsBQXWwugXDdgnyBiq7Q9';

DO $mig$
DECLARE n int;
BEGIN
  UPDATE public.candy_listings
     SET is_active = false,
         owner_moved_at = COALESCE(owner_moved_at, now())
   WHERE pda_address = 'CFGipvw9iq69QEpdr3yiNjvYsBQXWwugXDdgnyBiq7Q9'
     AND is_active
     AND NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                      WHERE w.collection_id = candy_listings.collection_id
                        AND w.moment_id = candy_listings.token_mint);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected to retire exactly 1 ask, matched % (premise changed — re-read before retrying)', n;
  END IF;
END
$mig$;
