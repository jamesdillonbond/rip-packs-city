-- 2026-11-08 (PT) — Giveaway packs: a BALANCED deal, chosen at seal and enforced here.
--
-- WHY (Trevor, 2026-11-08: "how I can assign moments into the pack content pool, so
-- that they can be randomized and shuffled as they're stuffed into packs for fairness
-- of who receives what from packs"). v1 sealed with one Fisher–Yates shuffle of the
-- whole pool: every arrangement equally likely, so one pack could hold every top
-- Moment while another held only the cheapest. A balanced deal ranks the pool by FMV
-- into `moments_per_pack` value bands of `pack_count` Moments; every pack gets exactly
-- one Moment from each band, chosen at random inside the band (lib/giveaways/seal.ts
-- dealBalanced). Slot k of every pack is band k.
--
-- WHAT.
--   giveaway_drops.deal_mode    'random' (the v1 deal; every existing drop) | 'balanced'.
--   seal_giveaway_drop_dealt()  seal + record the mode, in ONE transaction. It runs the
--                               unchanged seal_giveaway_drop (status, exactly-once
--                               coverage, commitment) and, for 'balanced', REFUSES any
--                               assignment where a moment's slot is not its value band:
--                               rank = row_number() over (fmv desc, moment_id COLLATE "C"),
--                               band = (rank - 1) / pack_count + 1. The public page says
--                               "one Moment from each value band per pack", and this is
--                               what makes that sentence true rather than a claim.
-- seal_giveaway_drop keeps its signature and body (a new NAME, not an overload: the
-- drift guard pins functions by name).
--
-- anon-exec: seal_giveaway_drop_dealt(uuid, jsonb, text, text, text) — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   DROP FUNCTION public.seal_giveaway_drop_dealt(uuid, jsonb, text, text, text);
--   ALTER TABLE public.giveaway_drops DROP COLUMN deal_mode;
--   (and revert the code commit "giveaways: balanced deal …", which calls the new function)

ALTER TABLE public.giveaway_drops
  ADD COLUMN IF NOT EXISTS deal_mode text NOT NULL DEFAULT 'random'
    CONSTRAINT giveaway_drops_deal_mode_check CHECK (deal_mode IN ('random', 'balanced'));

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
  v_bad int;
BEGIN
  IF p_deal_mode IS NULL OR p_deal_mode NOT IN ('random', 'balanced') THEN
    RAISE EXCEPTION 'giveaway: deal mode must be random or balanced' USING ERRCODE = '22023';
  END IF;

  -- status, exactly-once coverage and the commitment: the v1 seal, unchanged
  PERFORM public.seal_giveaway_drop(p_drop_id, p_assignments, p_hash, p_salt);

  IF p_deal_mode = 'balanced' THEN
    SELECT d.pack_count INTO v_packs FROM public.giveaway_drops d WHERE d.id = p_drop_id;
    IF EXISTS (SELECT 1 FROM public.giveaway_pack_moments m
                WHERE m.drop_id = p_drop_id AND m.fmv_usd IS NULL) THEN
      RAISE EXCEPTION 'giveaway: a balanced deal needs every moment priced' USING ERRCODE = '22023';
    END IF;
    SELECT count(*) INTO v_bad
      FROM (SELECT m.slot,
                   (row_number() OVER (ORDER BY m.fmv_usd DESC, m.moment_id COLLATE "C") - 1) / v_packs + 1 AS band
              FROM public.giveaway_pack_moments m
             WHERE m.drop_id = p_drop_id) r
     WHERE r.slot <> r.band;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'giveaway: not a balanced deal (% moments outside their value band)', v_bad USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.giveaway_drops SET deal_mode = p_deal_mode, updated_at = now() WHERE id = p_drop_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.seal_giveaway_drop_dealt(uuid, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seal_giveaway_drop_dealt(uuid, jsonb, text, text, text) TO postgres, service_role;
