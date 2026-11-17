-- 2026-11-08 (PT) — Giveaway packs: INSTANT delivery from a giveaway vault.
--
-- WHY (Trevor, 2026-11-08: "Is there a way for the moments to instantly flow to
-- the pack openers upon opening the pack?" → "Do what makes sense and proceed
-- with it all the way through"). Until now every Moment waited for the sponsor
-- to approve "Deliver all" in their Flow Wallet. Instant delivery needs a signer
-- that is there at claim time, so a sponsor may FUND a sealed drop: they move
-- its pool into the giveaway vault (a plain Flow account whose key only the
-- server holds, lib/giveaways/vault.ts), and from then on each claim's Moments
-- are sent from the vault seconds after the claim. Funding also closes the
-- trust gap the 09-29 reassessment named: a funded pool can no longer be sold
-- by the sponsor between sealing and delivery.
--
-- WHAT.
--   giveaway_drops.vault_address            the vault a drop's pool was moved into (NULL = not funded).
--   giveaway_pack_moments.funded_from       the account a Moment came from, so an unclaimed one goes BACK there.
--   giveaway_pack_moments.delivery_tx_id / delivery_attempted_at / delivery_error
--                                           the vault send for that Moment (attempt stamp = the send lock).
--   mark_giveaway_vault_funded()            after the server has read the chain and seen the vault hold
--                                           EVERY undelivered pool Moment: remember where each came from
--                                           and make the vault its source (so verify, claims and the
--                                           delivery checks all read the vault).
--   reserve_giveaway_vault_send()           the send lock: hands out a claimed pack's undelivered vault
--                                           Moments with the claim's recorded recipient, at most once per
--                                           3 minutes per Moment, so two triggers can never both send.
--                                           p_return = true hands out the UNCLAIMED Moments of a CLOSED
--                                           drop with their funded_from as the recipient (return to sponsor).
-- The vault can only ever be asked to send to a recipient this database recorded:
-- the claim's recipient_address, or the Moment's own funded_from. No request body
-- names a recipient.
--
-- anon-exec: mark_giveaway_vault_funded(uuid, text) — new; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: reserve_giveaway_vault_send(uuid, int, boolean) — new; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: unchanged (claim_giveaway_pack) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false 2026-11-08.
--   claim_giveaway_pack: also refuses a recipient that is any pool Moment's funded_from, so funding
--   a drop does not reopen "the sponsor can win their own pack via their linked account".
--   Base verified: live prosrc md5 2fd6ab53… = the 20261003230716 body, re-read immediately before this replace (2026-11-08 PT).
--
-- Revert claim_giveaway_pack: re-apply its body from 20261003230716_audit_20261003_giveaway_pool_spans_linked_wallets.sql.
-- Revert (after reverting the code commit "giveaways: instant delivery from the giveaway vault"):
--   DROP FUNCTION public.reserve_giveaway_vault_send(uuid, int, boolean);
--   DROP FUNCTION public.mark_giveaway_vault_funded(uuid, text);
--   ALTER TABLE public.giveaway_pack_moments DROP COLUMN funded_from, DROP COLUMN delivery_tx_id,
--     DROP COLUMN delivery_attempted_at, DROP COLUMN delivery_error;
--   ALTER TABLE public.giveaway_drops DROP COLUMN vault_address;
--   ⚠ Only once the vault holds no pool Moments (return them first), or their
--   origin is lost with funded_from.

ALTER TABLE public.giveaway_drops
  ADD COLUMN IF NOT EXISTS vault_address text
    CONSTRAINT giveaway_drops_vault_address_format CHECK (vault_address IS NULL OR vault_address ~ '^0x[0-9a-f]{16}$');

ALTER TABLE public.giveaway_pack_moments
  ADD COLUMN IF NOT EXISTS funded_from text
    CONSTRAINT giveaway_pack_moments_funded_from_format CHECK (funded_from IS NULL OR funded_from ~ '^0x[0-9a-f]{16}$'),
  ADD COLUMN IF NOT EXISTS delivery_tx_id text
    CONSTRAINT giveaway_pack_moments_delivery_tx_format CHECK (delivery_tx_id IS NULL OR delivery_tx_id ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS delivery_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_error text
    CONSTRAINT giveaway_pack_moments_delivery_error_len CHECK (delivery_error IS NULL OR char_length(delivery_error) <= 500);

CREATE OR REPLACE FUNCTION public.mark_giveaway_vault_funded(p_drop_id uuid, p_vault text)
RETURNS int
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_drop public.giveaway_drops;
  v_vault text := lower(trim(p_vault));
  v_n int;
BEGIN
  IF v_vault !~ '^0x[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'giveaway: the vault is not a Flow address' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_drop FROM public.giveaway_drops d WHERE d.id = p_drop_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'giveaway: no such drop' USING ERRCODE = '22023';
  END IF;
  IF v_drop.status NOT IN ('sealed', 'open') THEN
    RAISE EXCEPTION 'giveaway: only a sealed or open drop can be funded (status is %)', v_drop.status USING ERRCODE = '22023';
  END IF;
  IF v_drop.vault_address IS NOT NULL AND v_drop.vault_address <> v_vault THEN
    RAISE EXCEPTION 'giveaway: this drop is already funded in %', v_drop.vault_address USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.giveaway_claims c WHERE c.drop_id = p_drop_id AND c.recipient_address = v_vault) THEN
    RAISE EXCEPTION 'giveaway: the vault is a claimer of this drop' USING ERRCODE = '22023';
  END IF;

  UPDATE public.giveaway_pack_moments m
     SET funded_from = COALESCE(m.funded_from, m.source_wallet),
         source_wallet = v_vault
   WHERE m.drop_id = p_drop_id
     AND m.delivered_at IS NULL
     AND m.source_wallet <> v_vault;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.giveaway_drops SET vault_address = v_vault, updated_at = now() WHERE id = p_drop_id;
  RETURN v_n;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mark_giveaway_vault_funded(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_giveaway_vault_funded(uuid, text) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.reserve_giveaway_vault_send(p_drop_id uuid, p_pack_no int, p_return boolean DEFAULT false)
RETURNS TABLE (moment_id text, recipient text)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_drop public.giveaway_drops;
BEGIN
  -- serialises every send on this drop with every claim on it
  SELECT * INTO v_drop FROM public.giveaway_drops d WHERE d.id = p_drop_id FOR UPDATE;
  IF NOT FOUND OR v_drop.vault_address IS NULL THEN
    RETURN;
  END IF;

  IF p_return THEN
    IF v_drop.status <> 'closed' THEN
      RAISE EXCEPTION 'giveaway: unclaimed Moments go back only after the drop closes' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    UPDATE public.giveaway_pack_moments m
       SET delivery_attempted_at = now(), delivery_error = NULL
     WHERE m.drop_id = p_drop_id
       AND m.source_wallet = v_drop.vault_address
       AND m.funded_from IS NOT NULL
       AND m.delivered_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.giveaway_claims c WHERE c.drop_id = p_drop_id AND c.pack_no = m.pack_no)
       AND (m.delivery_attempted_at IS NULL OR m.delivery_attempted_at < now() - interval '3 minutes')
    RETURNING m.moment_id, m.funded_from;
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.giveaway_pack_moments m
     SET delivery_attempted_at = now(), delivery_error = NULL
    FROM public.giveaway_claims c
   WHERE m.drop_id = p_drop_id
     AND c.drop_id = p_drop_id
     AND c.pack_no = m.pack_no
     AND (p_pack_no IS NULL OR m.pack_no = p_pack_no)
     AND m.source_wallet = v_drop.vault_address
     AND m.delivered_at IS NULL
     AND (m.delivery_attempted_at IS NULL OR m.delivery_attempted_at < now() - interval '3 minutes')
  RETURNING m.moment_id, c.recipient_address;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reserve_giveaway_vault_send(uuid, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_giveaway_vault_send(uuid, int, boolean) TO postgres, service_role;

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
