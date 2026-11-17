-- 2026-11-10 (Trevor: "lock it up and start working on stuffing packs for those that completed").
--
-- A giveaway drop was claimable by ANY signed-in account; pack_count was the only
-- limit. A reward drop for Dame Time finishers would therefore hand packs to whoever
-- reached the link first. This adds an optional link from a drop to one trophy
-- challenge: when set, claim_giveaway_pack refuses ('not_eligible') any user without
-- a COMPLETED case in that challenge. NULL keeps every existing drop exactly as it was.
--
-- The check sits after the open check and before every recipient check, so an
-- ineligible user learns nothing about the pool or other claims.
--
-- Applied 2026-11-10 1:42 PM PT on Trevor's OK; live prosrc md5 after apply e9514817459d12ad75e9bfe101e51c13.
-- Base verified 2026-11-10 1:45 PM PT: live prosrc md5 4486345cbba474abda789dab7537383c
-- = the body in 20261108231643 (the pinned migration). Grants unchanged
-- (CREATE OR REPLACE keeps 20260929192842's REVOKE public/anon/authenticated + GRANT
-- postgres, service_role).
--
-- Revert: re-apply claim_giveaway_pack from 20261108231643, then
--   ALTER TABLE public.giveaway_drops DROP COLUMN eligible_challenge_id;

ALTER TABLE public.giveaway_drops
  ADD COLUMN IF NOT EXISTS eligible_challenge_id uuid REFERENCES public.trophy_challenges(id);

COMMENT ON COLUMN public.giveaway_drops.eligible_challenge_id IS
  'When set, only users with a completed trophy_cases row in this challenge may claim (claim_giveaway_pack -> not_eligible). 2026-11-10.';

-- anon-exec: unchanged (claim_giveaway_pack) — CREATE OR REPLACE of an existing fn; ACL preserved (REVOKE PUBLIC/anon/authenticated in 20260929192842), verified after apply: EXECUTE = postgres, service_role only.
CREATE OR REPLACE FUNCTION public.claim_giveaway_pack(
  p_drop_id uuid,
  p_user_id uuid,
  p_username text,
  p_recipient text
)
RETURNS TABLE (pack_no int, outcome text)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_drop public.giveaway_drops;
  v_pack int;
  v_recipient text := lower(trim(p_recipient));
BEGIN
  -- serialises every claim on this drop: two claims can never pick the same pack
  SELECT * INTO v_drop FROM public.giveaway_drops d WHERE d.id = p_drop_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::int, 'not_found'::text; RETURN;
  END IF;

  SELECT c.pack_no INTO v_pack
    FROM public.giveaway_claims c
   WHERE c.drop_id = p_drop_id AND c.user_id = p_user_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_pack, 'already_claimed'::text; RETURN;
  END IF;

  IF v_drop.status <> 'open' THEN
    RETURN QUERY SELECT NULL::int, 'not_open'::text; RETURN;
  END IF;

  -- a reward drop for one trophy challenge: only a collector with a COMPLETED case
  -- in that challenge may claim (2026-11-10, Dame Time finisher packs)
  IF v_drop.eligible_challenge_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.trophy_cases tc
                      WHERE tc.challenge_id = v_drop.eligible_challenge_id
                        AND tc.user_id = p_user_id
                        AND tc.completed_at IS NOT NULL) THEN
    RETURN QUERY SELECT NULL::int, 'not_eligible'::text; RETURN;
  END IF;

  -- the sponsor's own wallet, or any account the pool is drawn from — including,
  -- once the pool is in the giveaway vault, the accounts it was funded from (2026-11-08)
  IF v_recipient = v_drop.admin_wallet
     OR EXISTS (SELECT 1 FROM public.giveaway_pack_moments m
                 WHERE m.drop_id = p_drop_id
                   AND (m.source_wallet = v_recipient OR m.funded_from = v_recipient)) THEN
    RETURN QUERY SELECT NULL::int, 'admin_recipient'::text; RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.giveaway_claims c
              WHERE c.drop_id = p_drop_id AND c.recipient_address = v_recipient) THEN
    RETURN QUERY SELECT NULL::int, 'recipient_taken'::text; RETURN;
  END IF;

  -- a uniformly random unclaimed pack (gen_random_uuid draws from the OS CSPRNG)
  SELECT g.n INTO v_pack
    FROM generate_series(1, v_drop.pack_count) AS g(n)
   WHERE NOT EXISTS (SELECT 1 FROM public.giveaway_claims c
                      WHERE c.drop_id = p_drop_id AND c.pack_no = g.n)
   ORDER BY gen_random_uuid()
   LIMIT 1;
  IF v_pack IS NULL THEN
    RETURN QUERY SELECT NULL::int, 'all_claimed'::text; RETURN;
  END IF;

  INSERT INTO public.giveaway_claims (drop_id, pack_no, user_id, topshot_username, recipient_address)
  VALUES (p_drop_id, v_pack, p_user_id, trim(p_username), v_recipient);

  RETURN QUERY SELECT v_pack, 'claimed'::text;
END;
$function$;
