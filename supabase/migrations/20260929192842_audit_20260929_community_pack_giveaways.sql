-- 2026-09-29 (PT) — Community pack giveaways, v1 (one admin: Trevor).
--
-- WHY (Trevor, 2026-09-29: "let's just start with me as the only admin for
-- now"). A giveaway drop is a set of the admin's own Top Shot moments, shuffled
-- into packs and given away FREE to whoever claims one. Background and the
-- legal read: docs/strategy/free-packs-reassessment-2026-09-29.md (§2, §7, §8).
--
-- RPC STAYS READ-ONLY. RPC never holds, signs for or sends a moment. The
-- admin gifts each claimed moment inside the Top Shot app; RPC shuffles the
-- packs, publishes a sealed hash of the assignment before claims open, assigns
-- a random unclaimed pack per claim, and verifies delivery by reading the
-- chain (the recipient holds the moment).
--
-- WHAT.
--   giveaway_drops           one row per drop; status draft -> sealed -> open -> closed.
--                            seal_hash is public from sealing; seal_salt only after close.
--   giveaway_pack_moments    the pool; pack_no/slot are NULL in a draft and set at sealing.
--                            Delivery state lives here (delivered_at + the last check).
--   giveaway_claims          one per (drop, pack), per (drop, account), per (drop, recipient).
--   claim_giveaway_pack()    atomic claim: row-locks the drop, refuses a second claim,
--                            picks a uniformly random unclaimed pack.
--   create_giveaway_draft()  atomic draft: the drop + its pool copied from the admin's
--                            own (unlocked) wallet_moments_cache rows.
--   seal_giveaway_drop()     atomic seal: the pack assignment + the commitment hash.
-- All four tables: RLS on, no anon/authenticated grants. Only the service-role
-- routes (app/api/giveaways/**, app/api/admin/giveaways/**) read or write them.
-- anon-exec: claim_giveaway_pack(uuid, uuid, text, text) — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   DROP FUNCTION public.claim_giveaway_pack(uuid, uuid, text, text);
--   DROP FUNCTION public.create_giveaway_draft(text, text, text, text, uuid, text, int, int, text[]);
--   DROP FUNCTION public.seal_giveaway_drop(uuid, jsonb, text, text);
--   DROP TABLE public.giveaway_claims, public.giveaway_pack_moments, public.giveaway_drops;

CREATE TABLE IF NOT EXISTS public.giveaway_drops (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,59}$'),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description       text CHECK (description IS NULL OR char_length(description) <= 2000),
  sponsor_name      text NOT NULL CHECK (char_length(sponsor_name) BETWEEN 2 AND 80),
  collection_id     uuid NOT NULL REFERENCES public.collections(id),
  admin_wallet      text NOT NULL CHECK (admin_wallet ~ '^0x[0-9a-f]{16}$'),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sealed', 'open', 'closed')),
  pack_count        int  NOT NULL CHECK (pack_count BETWEEN 1 AND 100),
  moments_per_pack  int  NOT NULL CHECK (moments_per_pack BETWEEN 1 AND 10),
  seal_hash         text CHECK (seal_hash IS NULL OR seal_hash ~ '^[0-9a-f]{64}$'),
  seal_salt         text CHECK (seal_salt IS NULL OR seal_salt ~ '^[0-9a-f]{64}$'),
  sealed_at         timestamptz,
  opened_at         timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- a sealed drop always carries both halves of its commitment
  CONSTRAINT giveaway_drops_sealed_has_commitment
    CHECK (status = 'draft' OR (seal_hash IS NOT NULL AND seal_salt IS NOT NULL AND sealed_at IS NOT NULL))
);
ALTER TABLE public.giveaway_drops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.giveaway_drops FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.giveaway_pack_moments (
  drop_id                   uuid NOT NULL REFERENCES public.giveaway_drops(id) ON DELETE CASCADE,
  moment_id                 text NOT NULL CHECK (moment_id ~ '^[0-9]{1,20}$'),
  pack_no                   int,
  slot                      int,
  edition_key               text,
  player_name               text,
  set_name                  text,
  team_name                 text,
  tier                      text,
  serial_number             int,
  fmv_usd                   numeric,
  image_url                 text,
  delivered_at              timestamptz,
  last_checked_at           timestamptz,
  last_check_recipient_holds boolean,
  last_check_admin_holds     boolean,
  PRIMARY KEY (drop_id, moment_id),
  CONSTRAINT giveaway_pack_moments_pack_and_slot_together CHECK ((pack_no IS NULL) = (slot IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS giveaway_pack_moments_pack_slot_uq
  ON public.giveaway_pack_moments (drop_id, pack_no, slot) WHERE pack_no IS NOT NULL;
ALTER TABLE public.giveaway_pack_moments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.giveaway_pack_moments FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.giveaway_claims (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id            uuid NOT NULL REFERENCES public.giveaway_drops(id) ON DELETE CASCADE,
  pack_no            int  NOT NULL,
  user_id            uuid NOT NULL,
  topshot_username   text NOT NULL,
  recipient_address  text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{16}$'),
  claimed_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drop_id, pack_no),
  UNIQUE (drop_id, user_id),
  UNIQUE (drop_id, recipient_address)
);
ALTER TABLE public.giveaway_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.giveaway_claims FROM anon, authenticated;

-- Atomic claim. Outcomes: claimed | already_claimed | not_found | not_open |
-- admin_recipient | recipient_taken | all_claimed. `pack_no` is set for
-- claimed and already_claimed (the caller's existing pack), NULL otherwise.
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

  IF v_recipient = v_drop.admin_wallet THEN
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

REVOKE EXECUTE ON FUNCTION public.claim_giveaway_pack(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_giveaway_pack(uuid, uuid, text, text) TO postgres, service_role;

-- Atomic draft: the drop row and its pool, copied from the admin's own
-- wallet_moments_cache rows (collection-scoped: a moment_id is unique only
-- within a collection). Refuses a moment the cache does not show the admin
-- holding, or shows LOCKED — a locked Top Shot moment cannot be gifted. The
-- cache is a hint here; sealing re-checks every moment on chain.
CREATE OR REPLACE FUNCTION public.create_giveaway_draft(
  p_slug text,
  p_title text,
  p_description text,
  p_sponsor_name text,
  p_collection_id uuid,
  p_admin_wallet text,
  p_pack_count int,
  p_moments_per_pack int,
  p_moment_ids text[]
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_wallet text := lower(trim(p_admin_wallet));
  v_ids text[] := ARRAY(SELECT DISTINCT unnest(p_moment_ids));
  v_found int;
  v_missing text[];
  v_locked text[];
BEGIN
  IF cardinality(v_ids) <> cardinality(p_moment_ids) THEN
    RAISE EXCEPTION 'giveaway: the pool lists a moment twice' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) <> p_pack_count * p_moments_per_pack THEN
    RAISE EXCEPTION 'giveaway: % moments selected; % packs of % need %',
      cardinality(v_ids), p_pack_count, p_moments_per_pack, p_pack_count * p_moments_per_pack
      USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT i FROM unnest(v_ids) i
                WHERE NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                                   WHERE w.wallet_address = v_wallet
                                     AND w.collection_id = p_collection_id
                                     AND w.moment_id = i))
    INTO v_missing;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'giveaway: not held by % per the cache: %', v_wallet, array_to_string(v_missing, ',')
      USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT w.moment_id FROM public.wallet_moments_cache w
                WHERE w.wallet_address = v_wallet
                  AND w.collection_id = p_collection_id
                  AND w.moment_id = ANY (v_ids)
                  AND w.is_locked IS NOT FALSE)
    INTO v_locked;
  IF cardinality(v_locked) > 0 THEN
    RAISE EXCEPTION 'giveaway: locked (or lock unknown), cannot be gifted: %', array_to_string(v_locked, ',')
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.giveaway_drops
    (slug, title, description, sponsor_name, collection_id, admin_wallet, pack_count, moments_per_pack)
  VALUES
    (lower(trim(p_slug)), trim(p_title), nullif(trim(p_description), ''), trim(p_sponsor_name),
     p_collection_id, v_wallet, p_pack_count, p_moments_per_pack)
  RETURNING id INTO v_id;

  INSERT INTO public.giveaway_pack_moments
    (drop_id, moment_id, edition_key, player_name, set_name, team_name, tier, serial_number, fmv_usd, image_url)
  SELECT DISTINCT ON (w.moment_id)
         v_id, w.moment_id, w.edition_key, w.player_name, w.set_name, w.team_name, w.tier,
         w.serial_number, w.fmv_usd, w.image_url
    FROM public.wallet_moments_cache w
   WHERE w.wallet_address = v_wallet
     AND w.collection_id = p_collection_id
     AND w.moment_id = ANY (v_ids)
   ORDER BY w.moment_id, w.last_seen_at DESC NULLS LAST;

  GET DIAGNOSTICS v_found = ROW_COUNT;
  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'giveaway: copied % of % pool moments', v_found, cardinality(v_ids) USING ERRCODE = 'P0001';
  END IF;
  RETURN v_id;
END;
$function$;
-- anon-exec: create_giveaway_draft(text, text, text, text, uuid, text, int, int, text[]) — new; REVOKE FROM PUBLIC, anon, authenticated below.
REVOKE EXECUTE ON FUNCTION public.create_giveaway_draft(text, text, text, text, uuid, text, int, int, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_giveaway_draft(text, text, text, text, uuid, text, int, int, text[]) TO postgres, service_role;

-- Atomic seal: every pool moment gets exactly one (pack, slot), and the drop
-- takes its commitment, in one transaction. The shuffle and the hash are made
-- by the caller (lib/giveaways/seal.ts); this refuses any assignment that does
-- not cover the pool exactly once with packs 1..pack_count, slots 1..per_pack.
CREATE OR REPLACE FUNCTION public.seal_giveaway_drop(
  p_drop_id uuid,
  p_assignments jsonb,
  p_hash text,
  p_salt text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_drop public.giveaway_drops;
  v_n int;
  v_ok int;
BEGIN
  SELECT * INTO v_drop FROM public.giveaway_drops d WHERE d.id = p_drop_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'giveaway: no such drop' USING ERRCODE = '22023';
  END IF;
  IF v_drop.status <> 'draft' THEN
    RAISE EXCEPTION 'giveaway: only a draft can be sealed (status is %)', v_drop.status USING ERRCODE = '22023';
  END IF;

  -- a second seal attempt in the same transaction must not trip over the first's table
  DROP TABLE IF EXISTS pg_temp._gw_assign;
  CREATE TEMP TABLE _gw_assign ON COMMIT DROP AS
  SELECT a->>'moment_id' AS moment_id, (a->>'pack_no')::int AS pack_no, (a->>'slot')::int AS slot
    FROM jsonb_array_elements(p_assignments) a;

  SELECT count(*) INTO v_n FROM public.giveaway_pack_moments m WHERE m.drop_id = p_drop_id;
  SELECT count(*) INTO v_ok
    FROM (SELECT DISTINCT moment_id FROM _gw_assign) x
    JOIN public.giveaway_pack_moments m ON m.drop_id = p_drop_id AND m.moment_id = x.moment_id;
  IF v_n <> v_drop.pack_count * v_drop.moments_per_pack
     OR (SELECT count(*) FROM _gw_assign) <> v_n
     OR v_ok <> v_n
     OR (SELECT count(DISTINCT (pack_no, slot)) FROM _gw_assign) <> v_n
     OR EXISTS (SELECT 1 FROM _gw_assign
                 WHERE pack_no IS NULL OR slot IS NULL
                    OR pack_no NOT BETWEEN 1 AND v_drop.pack_count
                    OR slot NOT BETWEEN 1 AND v_drop.moments_per_pack) THEN
    RAISE EXCEPTION 'giveaway: the assignment does not cover the pool exactly once' USING ERRCODE = '22023';
  END IF;

  UPDATE public.giveaway_pack_moments m
     SET pack_no = a.pack_no, slot = a.slot
    FROM _gw_assign a
   WHERE m.drop_id = p_drop_id AND m.moment_id = a.moment_id;

  UPDATE public.giveaway_drops
     SET status = 'sealed', seal_hash = lower(p_hash), seal_salt = lower(p_salt),
         sealed_at = now(), updated_at = now()
   WHERE id = p_drop_id;
END;
$function$;
-- anon-exec: seal_giveaway_drop(uuid, jsonb, text, text) — new; REVOKE FROM PUBLIC, anon, authenticated below.
REVOKE EXECUTE ON FUNCTION public.seal_giveaway_drop(uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seal_giveaway_drop(uuid, jsonb, text, text) TO postgres, service_role;
