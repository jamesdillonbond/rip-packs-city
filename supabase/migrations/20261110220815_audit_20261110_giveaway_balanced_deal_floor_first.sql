-- 2026-11-10 (Trevor, stuffing the Dame Time finisher packs: "Slot 1 should be the floor").
--
-- The balanced deal cuts the pool into value bands (band 1 = the top packCount Moments)
-- and gives every pack exactly one Moment from each band. Until now band k filled slot k,
-- so a pack opened on its BEST Moment. This flips the mapping: band k fills slot
-- (moments_per_pack - k + 1), so slot 1 holds the cheapest band and the last slot the top
-- band — a pack opens floor-first and ends on its best Moment. The balance property is
-- unchanged (one per band per pack); only which slot each band lands in moves.
--
-- No sealed drop has ever used deal_mode 'balanced' (all three past drops are random), so
-- nothing sealed is re-judged. lib/giveaways/seal.ts dealBalanced flips in the same commit.
--
-- Applied 2026-11-10 ~2:30 PM PT; live prosrc md5 after apply fdb7fa7691bb9e92227e4f309e57d9ce.
-- Base verified 2026-11-10 ~2:25 PM PT: live prosrc md5 dd8600646af99979f64043d0f8b51216
-- = the body in 20261108205511.
--
-- anon-exec: unchanged (seal_giveaway_drop_dealt) — CREATE OR REPLACE of an existing fn; ACL preserved (REVOKE PUBLIC/anon/authenticated + GRANT postgres, service_role in 20261108205511).
--
-- Revert: re-apply seal_giveaway_drop_dealt from 20261108205511 (and revert dealBalanced).

CREATE OR REPLACE FUNCTION public.seal_giveaway_drop_dealt(
  p_drop_id uuid,
  p_assignments jsonb,
  p_hash text,
  p_salt text,
  p_deal_mode text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_packs int;
  v_per int;
  v_bad int;
BEGIN
  IF p_deal_mode IS NULL OR p_deal_mode NOT IN ('random', 'balanced') THEN
    RAISE EXCEPTION 'giveaway: deal mode must be random or balanced' USING ERRCODE = '22023';
  END IF;

  -- status, exactly-once coverage and the commitment: the v1 seal, unchanged
  PERFORM public.seal_giveaway_drop(p_drop_id, p_assignments, p_hash, p_salt);

  IF p_deal_mode = 'balanced' THEN
    SELECT d.pack_count, d.moments_per_pack INTO v_packs, v_per FROM public.giveaway_drops d WHERE d.id = p_drop_id;
    IF EXISTS (SELECT 1 FROM public.giveaway_pack_moments m
                WHERE m.drop_id = p_drop_id AND m.fmv_usd IS NULL) THEN
      RAISE EXCEPTION 'giveaway: a balanced deal needs every moment priced' USING ERRCODE = '22023';
    END IF;
    SELECT count(*) INTO v_bad
      FROM (SELECT m.slot,
                   (row_number() OVER (ORDER BY m.fmv_usd DESC, m.moment_id COLLATE "C") - 1) / v_packs + 1 AS band
              FROM public.giveaway_pack_moments m
             WHERE m.drop_id = p_drop_id) r
     -- band 1 (the top Moments) fills the LAST slot, the cheapest band slot 1, so a pack
     -- opens floor-first and ends on its best Moment (Trevor 2026-11-10: "Slot 1 should be the floor")
     WHERE r.slot <> v_per - r.band + 1;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'giveaway: not a balanced deal (% moments outside their value band)', v_bad USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.giveaway_drops SET deal_mode = p_deal_mode, updated_at = now() WHERE id = p_drop_id;
END;
$function$;
