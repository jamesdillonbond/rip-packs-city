-- A pack that LEAVES a wallet is never named by a later walk, so the wallet's
-- inventory kept claiming it.
--
-- MEASURED 2026-09-20 (PT), across the 27 saved wallets, using each wallet's own
-- completed sync as the control:
--
--   wallet              not_returned_by_its_own_walk   of which Sealed
--   0x7e38edfe0510024a                            12                12
--   0x8bf951fe6f7918b1                             5                 5
--   0xf06746d6d596ba89                             4                 4
--   0x35873ed90cebb570                             1                 1
--   0xdd33ebbda61f2918                             1                 1
--   (22 other wallets)                             0                 0
--
-- 23 rows, and 23 of 23 are Sealed. That 100% is the tell, not a coincidence:
-- pack_nft_identity_queue only ever enqueues a pack that carries a purchase or a
-- rip row, so an OPENED pack that leaves gets re-checked through the new owner's
-- purchase, while a SEALED pack that leaves by transfer has no re-check path at
-- all. Its row keeps owner_address = the old wallet forever.
--
-- get_wallet_pack_history's index_holds CTE reads exactly
--   owner_address = v_wallet AND status IN ('Sealed','Opened')
-- so all 23 classify as 'held' -- presented to the user, in their own inventory,
-- as unopened packs they still own. They do not own them. This is the
-- failed/stale-read-rendered-as-fact class in CLAUDE.md: the index is not wrong
-- about what it last SAW, the reader is wrong to treat a last-seen as a now.
--
-- The 'transferred' arm could not catch them either -- it tests
-- `current_owner <> v_wallet`, and a stale row still says the owner IS us.
--
-- FIX, entirely on the READ side. Dapper's last CLEAN full walk of a wallet is
-- the authority on what that wallet holds: any row still naming the wallet that
-- the walk did not touch is a pack it no longer holds. pack_wallet_sync gains a
-- last_clean_sync_at floor (preserved across re-dispatch, unlike completed_at,
-- which request_wallet_pack_sync resets to NULL), a BEFORE trigger stamps it on
-- a clean completion and on nothing else, and get_wallet_pack_history trusts an
-- ownership claim only at or after that floor.
--
-- No row is mutated and no ownership is invented: a departed pack keeps its
-- last-seen state, the reader simply stops reporting it as a current holding,
-- and the payload now carries the provenance (identity_departed, and
-- last_clean_sync_at inside identity_sync) instead of asserting silently.
--
-- The guard is OFF (NULL floor) for a wallet with no clean walk -- never yet
-- synced, sync in flight, sync errored, or the 60-page cap hit. A partial walk
-- must never be read as "everything it missed is gone": that is the same defect
-- pointing the other way.
--
-- collect_pack_nft_identity is NOT touched: at 15.6 KB it is the hot lane, and
-- rewriting its whole body to add one assignment is the larger risk. The trigger
-- also covers any future writer of pack_wallet_sync, which a line inside that
-- one function would not.
--
-- REVERT, cheapest first:
--   1. `UPDATE public.pack_wallet_sync SET last_clean_sync_at = NULL;` disarms
--      the read guard completely and row for row -- a NULL floor is exactly the
--      previous behaviour -- without touching a single function. The trigger
--      re-stamps on the next clean walk, so pair it with (2) to make it stick.
--   2. `DROP TRIGGER pack_wallet_sync_stamp_clean_floor_trg ON public.pack_wallet_sync;`
--   3. Full restore of the reader: the pre-change body is
--      md5 06e374cfee3afb40d103f54c5f7881f8 (16702 chars), committed verbatim in
--      supabase/migrations/20260919041500_audit_20260918_wallet_pack_holdings_synced_from_dapper_index_the_unopened_tab_was_a_quarter_of_the_truth.sql
--   4. Sweep: SELECT cron.schedule('rpc-wallet-pack-sync-sweep', '17 * * * *',
--        $$SELECT public.sweep_saved_wallet_pack_syncs(10);$$);


-- ---------------------------------------------------------------------------
-- 1. The floor column.
-- ---------------------------------------------------------------------------

ALTER TABLE public.pack_wallet_sync
  ADD COLUMN IF NOT EXISTS last_clean_sync_at timestamptz;

COMMENT ON COLUMN public.pack_wallet_sync.last_clean_sync_at IS
  'requested_at of the most recent CLEAN full walk of this wallet (every page '
  'collected, no error, page cap not hit). Written ONLY by the BEFORE trigger '
  'pack_wallet_sync_stamp_clean_floor_trg -- a trigger has no textual caller, so '
  'grepping for this column name will not find its writer -- and never cleared '
  'by request_wallet_pack_sync, so it survives a re-dispatch that resets '
  'completed_at to NULL. It is the confirmation floor for an ownership claim in '
  'pack_nft_identity: a row naming this wallet with checked_at < this value was '
  'not returned by that walk, i.e. the wallet no longer holds that pack. NULL '
  'means no clean walk has ever finished -- readers must then trust the index '
  'as-is rather than suppress, or a partial walk reads as a mass departure.';

-- Backfill from the rows that already describe a clean completion. Every one of
-- these walks stamped checked_at = now() on each pack it returned, all of them
-- after requested_at, so requested_at is the correct floor retroactively.
UPDATE public.pack_wallet_sync
   SET last_clean_sync_at = requested_at
 WHERE completed_at IS NOT NULL
   AND completed_at >= requested_at
   AND last_error IS NULL
   AND last_clean_sync_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. The 23 rows this changes, recorded before the reader stops counting them,
--    so the effect stays measurable after the fact.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.audit_20260920_pack_identity_departed_holds (
  wallet          text        NOT NULL,
  collection_id   uuid        NOT NULL,
  pack_nft_id     text        NOT NULL,
  status          text        NOT NULL,
  checked_at      timestamptz NOT NULL,
  sync_floor      timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, collection_id, pack_nft_id)
);

ALTER TABLE public.audit_20260920_pack_identity_departed_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260920_pack_identity_departed_holds FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.audit_20260920_pack_identity_departed_holds IS
  'The pack_nft_identity rows that were claiming a saved wallet still held them '
  'at the moment the last_clean_sync_at read guard shipped (2026-09-20). Each '
  'was owner_address = that wallet with checked_at before the wallet own last '
  'clean walk, i.e. Dapper did not return it for that wallet. Evidence table: '
  'nothing reads it, and it is safe to drop once the change has been reviewed.';

INSERT INTO public.audit_20260920_pack_identity_departed_holds
  (wallet, collection_id, pack_nft_id, status, checked_at, sync_floor)
SELECT s.wallet, i.collection_id, i.pack_nft_id, i.status, i.checked_at, s.last_clean_sync_at
  FROM public.pack_wallet_sync s
  JOIN public.pack_nft_identity i ON i.owner_address = s.wallet
 WHERE s.last_clean_sync_at IS NOT NULL
   AND i.checked_at < s.last_clean_sync_at
ON CONFLICT (wallet, collection_id, pack_nft_id) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 3. The writer. A TRIGGER, not a line inside collect_pack_nft_identity, so the
--    floor is stamped by the FACT of a clean completion rather than by one code
--    path remembering to. collect_pack_nft_identity is 15.6 KB and is the hot
--    lane; replacing its whole body to add one assignment is the larger risk,
--    and a second writer arriving later would silently not stamp.
--
-- ⚠ A trigger has no textual caller -- grepping for last_clean_sync_at will not
--    find what sets it. That is what the column comment above is for.
-- ---------------------------------------------------------------------------

-- anon-exec: intentional — REVOKEd below. A trigger function is fired by the
-- trigger machinery (privilege is checked at CREATE TRIGGER time, not per row),
-- so removing EXECUTE cannot orphan the lane that writes pack_wallet_sync.
CREATE OR REPLACE FUNCTION public.pack_wallet_sync_stamp_clean_floor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A CLEAN completion only: completed, no error recorded, and the completion
  -- is of THIS request (completed_at >= requested_at, never a stale stamp left
  -- over from the previous walk). The 60-page cap writes a last_error, so a
  -- capped -- i.e. partial -- walk is excluded here by construction.
  IF NEW.completed_at IS NOT NULL
     AND NEW.last_error IS NULL
     AND NEW.requested_at IS NOT NULL
     AND NEW.completed_at >= NEW.requested_at
  THEN
    NEW.last_clean_sync_at := NEW.requested_at;
  END IF;
  -- Every other shape leaves the column ALONE rather than clearing it. That is
  -- the load-bearing half: request_wallet_pack_sync re-dispatches with
  -- completed_at = NULL, and if that wiped the floor the read guard would
  -- switch off for the minutes a sync is in flight -- exactly when a user is
  -- most likely to be looking at the page that triggered it.
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.pack_wallet_sync_stamp_clean_floor()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pack_wallet_sync_stamp_clean_floor_trg ON public.pack_wallet_sync;
CREATE TRIGGER pack_wallet_sync_stamp_clean_floor_trg
  BEFORE INSERT OR UPDATE ON public.pack_wallet_sync
  FOR EACH ROW EXECUTE FUNCTION public.pack_wallet_sync_stamp_clean_floor();
