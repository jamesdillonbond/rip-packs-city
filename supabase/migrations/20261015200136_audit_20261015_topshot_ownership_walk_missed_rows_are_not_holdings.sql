-- audit_20261015_topshot_ownership_walk_missed_rows_are_not_holdings
--
-- MEASURED 2026-10-15 ~12:45 PM PT (cloud session, ahead of Top Shot Series 2026-27, where rookie
-- trade-in auctions "take Moments out of circulation" all season).
--
-- `ownership-onchain-walk` reads each holder wallet's live TopShot moment-ID set and re-stamps every
-- row it still holds. A row the wallet NO LONGER holds is counted as `vanished` and LEFT IN PLACE --
-- the route's own header says its aging observed_at "flags the staleness". No reader filters on it, so
-- a moment that was traded in (burned), sold off-market, or moved stays credited to its old holder
-- forever. ~24,500 rows are re-reported `vanished` on EVERY walk run (6 runs/day, 15-10-15).
--
--   * Series 8 Rookie Debut: 70,089 ownership rows for 70,089 minted, while Atlas reports 8,798 of
--     them BURNED (12.6 %) -- the census reads 115 % of live supply.
--   * topshot_rookie_collector_leaderboard_mv (the "Top collectors" panel on every 2025-rookie player
--     page): 10,121 of 76,718 rows are walk-missed; excluding them changes the top-3 of 36 of 61
--     rookies when ranked by moment count, and 5 such top-3 entries hold NONE of that player.
--   * Chain check, Flow REST borrowMoment on 6 wallets: 24/24 walk-missed rows are NOT in the wallet,
--     24/24 walk-confirmed rows ARE (positive + negative control).
--
-- Why a FLAG, not a delete: the Dune sync decides whether a stale cache needs a PAID re-walk by
-- comparing count(source='dune') with the cached execution's row count (sync-topshot-ownership-dune,
-- "stale-cache walk"). Deleting dune-sourced rows would make that check authorise a re-walk that
-- re-inserts the same stale rows. The row stays; it just stops counting as a holding.
--
-- THE CHANGE
--   1. topshot_ownership.walk_missed_at -- set when a clean on-chain walk of `owner_address` did not
--      find the moment. NULL = no walk has contradicted the claim (fail OPEN: an unwalked or
--      unreadable wallet keeps its rows).
--   2. A BEFORE UPDATE trigger clears it when the row is re-confirmed or moves: a newer observed_at
--      (the walk's own re-stamp, a sale re-attribution) or a different owner (Dune re-discovery,
--      sale re-attribution). Every writer clears it without being edited.
--   3. mark_topshot_ownership_walk_missed(owners[], nft_ids[], walk_at) -- the walk route's write;
--      only flags a row still on that owner and observed BEFORE the walk started, so a concurrent
--      re-attribution or Dune move is never flagged.
--   4. One-off backfill from the rows the walks already contradicted: per owner, the newest walk
--      stamp (excluding rows the hourly sale re-attribution wrote, which carry sold_at -- 1,523 rows
--      would otherwise be mis-flagged); a row observed more than 1 min before it is walk-missed.
--      Every flagged row is recorded in flowty_archive.audit_20261015_ownership_walk_missed.
--   Readers are switched in the companion migrations 20261015200615 (boards) and docs/pending-sql/audit_20261015_edition_concentration_counts_held_live_supply.sql (squeeze concentration, awaiting the SQL editor).
--
-- REVERT:
--   UPDATE public.topshot_ownership SET walk_missed_at = NULL WHERE walk_missed_at IS NOT NULL;
--   DROP TRIGGER trg_topshot_ownership_walk_missed_clear ON public.topshot_ownership;
--   DROP FUNCTION public.topshot_ownership_walk_missed_clear();
--   DROP FUNCTION public.mark_topshot_ownership_walk_missed(text[], text[], timestamptz);
--   ALTER TABLE public.topshot_ownership DROP COLUMN walk_missed_at;   -- after reverting 20261015200615 (and the concentration file once applied)

ALTER TABLE public.topshot_ownership ADD COLUMN IF NOT EXISTS walk_missed_at timestamptz;

COMMENT ON COLUMN public.topshot_ownership.walk_missed_at IS
  'Set when an on-chain walk of owner_address did not find this moment (traded in / burned / moved). '
  'NULL = not contradicted. Holdings readers count only walk_missed_at IS NULL. Cleared by trigger on '
  're-confirmation (newer observed_at) or an owner change. audit_20261015.';

CREATE OR REPLACE FUNCTION public.topshot_ownership_walk_missed_clear()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.walk_missed_at IS NOT NULL
     AND (NEW.owner_address IS DISTINCT FROM OLD.owner_address
          OR NEW.observed_at > OLD.observed_at
          OR NEW.observed_at >= NEW.walk_missed_at) THEN
    -- a write that SETS the flag leaves owner and observed_at untouched, so it never clears itself
    IF OLD.walk_missed_at IS NOT DISTINCT FROM NEW.walk_missed_at
       OR NEW.owner_address IS DISTINCT FROM OLD.owner_address
       OR NEW.observed_at > OLD.observed_at THEN
      NEW.walk_missed_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_topshot_ownership_walk_missed_clear
  BEFORE UPDATE ON public.topshot_ownership
  FOR EACH ROW EXECUTE FUNCTION public.topshot_ownership_walk_missed_clear();

CREATE OR REPLACE FUNCTION public.mark_topshot_ownership_walk_missed(
  p_owners text[], p_nft_ids text[], p_walk_at timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer;
BEGIN
  IF p_owners IS NULL OR p_nft_ids IS NULL OR p_walk_at IS NULL
     OR cardinality(p_owners) <> cardinality(p_nft_ids) THEN
    RAISE EXCEPTION 'mark_topshot_ownership_walk_missed: owners and nft_ids must be equal-length, walk_at required';
  END IF;
  UPDATE public.topshot_ownership o
     SET walk_missed_at = p_walk_at
    FROM unnest(p_owners, p_nft_ids) AS m(owner_address, nft_id)
   WHERE o.nft_id = m.nft_id
     AND o.owner_address = m.owner_address
     AND o.observed_at < p_walk_at
     AND o.walk_missed_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.mark_topshot_ownership_walk_missed(text[], text[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_topshot_ownership_walk_missed(text[], text[], timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.topshot_ownership_walk_missed_clear() FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261015_ownership_walk_missed (
  applied_at     timestamptz NOT NULL DEFAULT now(),
  nft_id         text        NOT NULL,
  owner_address  text        NOT NULL,
  observed_at    timestamptz NOT NULL,
  source         text,
  walk_at        timestamptz NOT NULL
);
REVOKE ALL ON flowty_archive.audit_20261015_ownership_walk_missed FROM PUBLIC, anon, authenticated;

-- One-off backfill (see 4. above). Archive first, then flag exactly the archived rows.
WITH ra AS (
  SELECT DISTINCT nft_id, new_owner, sale_sold_at
    FROM flowty_archive.audit_20261010_179_ownership_reattrib
), lw AS (
  SELECT o.owner_address, max(o.observed_at) AS walk_at
    FROM public.topshot_ownership o
   WHERE o.source = 'onchain_walk'
     AND NOT EXISTS (SELECT 1 FROM ra WHERE ra.nft_id = o.nft_id AND ra.new_owner = o.owner_address
                                        AND ra.sale_sold_at = o.observed_at)
   GROUP BY 1
)
INSERT INTO flowty_archive.audit_20261015_ownership_walk_missed (nft_id, owner_address, observed_at, source, walk_at)
SELECT o.nft_id, o.owner_address, o.observed_at, o.source, lw.walk_at
  FROM public.topshot_ownership o
  JOIN lw USING (owner_address)
 WHERE o.observed_at < lw.walk_at - interval '1 minute'
   AND o.walk_missed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM ra WHERE ra.nft_id = o.nft_id AND ra.new_owner = o.owner_address
                                      AND ra.sale_sold_at = o.observed_at);

UPDATE public.topshot_ownership o
   SET walk_missed_at = m.walk_at
  FROM flowty_archive.audit_20261015_ownership_walk_missed m
 WHERE o.nft_id = m.nft_id
   AND o.owner_address = m.owner_address
   AND o.observed_at = m.observed_at
   AND o.walk_missed_at IS NULL;
