-- DB invariant: community pack giveaways — create_giveaway_draft, seal_giveaway_drop,
-- claim_giveaway_pack (supabase/migrations/20260929192842_audit_20260929_community_pack_giveaways.sql;
-- create_giveaway_draft (now a pass-through) + claim_giveaway_pack redefined and create_giveaway_draft_multi added by
-- 20261003230716_audit_20261003_giveaway_pool_spans_linked_wallets.sql: a pool spans the sponsor's linked accounts).
-- The properties that matter:
--   * a draft copies ONLY the admin's own, UNLOCKED, same-collection cache rows
--     (a moment_id is unique only within a collection);
--   * a seal covers the pool exactly once, and only a draft can be sealed;
--   * a claim is refused unless the drop is open, is one per account and per
--     recipient, never to the admin's own wallet, and never hands out a pack twice.
--   * a multi-account pool checks every (moment, source) pair against THAT source's
--     cache rows, stores the source, and a claim can't target any pool source.
--   * a BALANCED seal (seal_giveaway_drop_dealt, 20261108205511_audit_20261108_giveaway_balanced_deal.sql)
--     is refused unless every moment's slot is its FMV value band; a random seal is
--     the v1 seal; either records the mode, and a refused seal changes nothing.
-- The function DDL below is a VERBATIM copy of the migration;
-- __tests__/db-invariants-drift-guard.test.ts fails CI if it drifts.
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (id uuid PRIMARY KEY);
INSERT INTO collections VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd'), ('dee28451-5d62-409e-a1ad-a83f763ac070');

CREATE TABLE wallet_moments_cache (
  wallet_address text, moment_id text, collection_id uuid, edition_key text, player_name text,
  set_name text, team_name text, tier text, serial_number int, fmv_usd numeric, image_url text,
  is_locked boolean, last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.giveaway_drops (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,59}$'),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description       text CHECK (description IS NULL OR char_length(description) <= 2000),
  sponsor_name      text NOT NULL CHECK (char_length(sponsor_name) BETWEEN 2 AND 80),
  collection_id     uuid NOT NULL REFERENCES collections(id),
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
  deal_mode         text NOT NULL DEFAULT 'random' CONSTRAINT giveaway_drops_deal_mode_check CHECK (deal_mode IN ('random', 'balanced')),
  vault_address     text,
  -- a sealed drop always carries both halves of its commitment
  CONSTRAINT giveaway_drops_sealed_has_commitment
    CHECK (status = 'draft' OR (seal_hash IS NOT NULL AND seal_salt IS NOT NULL AND sealed_at IS NOT NULL))
);

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
  source_wallet             text NOT NULL CHECK (source_wallet ~ '^0x[0-9a-f]{16}$'),
  funded_from               text,
  delivery_tx_id            text,
  delivery_attempted_at     timestamptz,
  delivery_error            text,
  PRIMARY KEY (drop_id, moment_id),
  CONSTRAINT giveaway_pack_moments_pack_and_slot_together CHECK ((pack_no IS NULL) = (slot IS NULL))
);

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

-- >>> BEGIN verbatim claim_giveaway_pack (keep byte-identical to the migration) >>>
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
-- <<< END verbatim claim_giveaway_pack <<<

-- >>> BEGIN verbatim create_giveaway_draft_multi (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.create_giveaway_draft_multi(
  p_slug text,
  p_title text,
  p_description text,
  p_sponsor_name text,
  p_collection_id uuid,
  p_admin_wallet text,
  p_pack_count int,
  p_moments_per_pack int,
  p_moment_ids text[],
  p_source_wallets text[]
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_wallet text := lower(trim(p_admin_wallet));
  v_ids text[] := ARRAY(SELECT DISTINCT unnest(p_moment_ids));
  v_sources text[];
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

  IF p_source_wallets IS NULL THEN
    v_sources := array_fill(v_wallet, ARRAY[cardinality(p_moment_ids)]);
  ELSE
    IF cardinality(p_source_wallets) <> cardinality(p_moment_ids) THEN
      RAISE EXCEPTION 'giveaway: % moments but % source wallets', cardinality(p_moment_ids), cardinality(p_source_wallets)
        USING ERRCODE = '22023';
    END IF;
    v_sources := ARRAY(SELECT lower(trim(s)) FROM unnest(p_source_wallets) WITH ORDINALITY AS u(s, n) ORDER BY n);
    IF EXISTS (SELECT 1 FROM unnest(v_sources) s WHERE s IS NULL OR s !~ '^0x[0-9a-f]{16}$') THEN
      RAISE EXCEPTION 'giveaway: a source wallet is not a Flow 0x address' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT ARRAY(SELECT p.mid || '@' || p.src FROM unnest(p_moment_ids, v_sources) AS p(mid, src)
                WHERE NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                                   WHERE w.wallet_address = p.src
                                     AND w.collection_id = p_collection_id
                                     AND w.moment_id = p.mid))
    INTO v_missing;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'giveaway: not held per the cache (moment@wallet): %', array_to_string(v_missing, ',')
      USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT DISTINCT w.moment_id FROM unnest(p_moment_ids, v_sources) AS p(mid, src)
                 JOIN public.wallet_moments_cache w
                   ON w.wallet_address = p.src
                  AND w.collection_id = p_collection_id
                  AND w.moment_id = p.mid
                WHERE w.is_locked IS NOT FALSE)
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
    (drop_id, moment_id, source_wallet, edition_key, player_name, set_name, team_name, tier, serial_number, fmv_usd, image_url)
  SELECT DISTINCT ON (p.mid)
         v_id, p.mid, p.src, w.edition_key, w.player_name, w.set_name, w.team_name, w.tier,
         w.serial_number, w.fmv_usd, w.image_url
    FROM unnest(p_moment_ids, v_sources) AS p(mid, src)
    JOIN public.wallet_moments_cache w
      ON w.wallet_address = p.src
     AND w.collection_id = p_collection_id
     AND w.moment_id = p.mid
   ORDER BY p.mid, w.last_seen_at DESC NULLS LAST;

  GET DIAGNOSTICS v_found = ROW_COUNT;
  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'giveaway: copied % of % pool moments', v_found, cardinality(v_ids) USING ERRCODE = 'P0001';
  END IF;
  RETURN v_id;
END;
$function$;
-- <<< END verbatim create_giveaway_draft_multi <<<

-- >>> BEGIN verbatim create_giveaway_draft (keep byte-identical to the migration) >>>
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
BEGIN
  -- v1 call: every moment comes from the admin wallet
  RETURN public.create_giveaway_draft_multi(p_slug, p_title, p_description, p_sponsor_name, p_collection_id,
                                            p_admin_wallet, p_pack_count, p_moments_per_pack, p_moment_ids, NULL);
END;
$function$;
-- <<< END verbatim create_giveaway_draft <<<

-- >>> BEGIN verbatim seal_giveaway_drop (keep byte-identical to the migration) >>>
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
-- <<< END verbatim seal_giveaway_drop <<<

-- >>> BEGIN verbatim seal_giveaway_drop_dealt (keep byte-identical to the migration) >>>
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
-- <<< END verbatim seal_giveaway_drop_dealt <<<

-- >>> BEGIN verbatim mark_giveaway_vault_funded (keep byte-identical to the migration) >>>
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
-- <<< END verbatim mark_giveaway_vault_funded <<<

-- >>> BEGIN verbatim reserve_giveaway_vault_send (keep byte-identical to the migration) >>>
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
-- <<< END verbatim reserve_giveaway_vault_send <<<

-- Admin 0x00000000000000aa holds Top Shot moments 1..5 (5 is LOCKED, 6 lock unknown).
-- Moment 7 exists under the admin only in ANOTHER collection.
INSERT INTO wallet_moments_cache (wallet_address, moment_id, collection_id, player_name, fmv_usd, is_locked, last_seen_at) VALUES
  ('0x00000000000000aa', '1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'A', 1.00, false, now()),
  ('0x00000000000000aa', '2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B', 2.00, false, now()),
  ('0x00000000000000aa', '3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'C', 3.00, false, now()),
  ('0x00000000000000aa', '4', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'D', 4.00, false, now()),
  ('0x00000000000000aa', '5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'E', 5.00, true,  now()),
  ('0x00000000000000aa', '6', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'F', 6.00, NULL,  now()),
  ('0x00000000000000aa', '7', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'G', 7.00, false, now()),
  ('0x00000000000000bb', '8', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'H', 8.00, false, now());

CREATE TEMP TABLE _gw_raised (label text, msg text);
CREATE OR REPLACE FUNCTION pg_temp._try_draft(p_label text, p_ids text[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM create_giveaway_draft('d-' || p_label, 'Test drop', NULL, 'Sponsor', '95f28a17-224a-4025-96ad-adf8a4c63bfd',
                                '0x00000000000000AA', 2, 2, p_ids);
  INSERT INTO _gw_raised VALUES (p_label, NULL);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _gw_raised VALUES (p_label, SQLERRM);
END $$;

-- D1..D5: every refusal
SELECT pg_temp._try_draft('count', ARRAY['1','2','3']);
SELECT pg_temp._try_draft('dupe', ARRAY['1','1','2','3']);
SELECT pg_temp._try_draft('locked', ARRAY['1','2','3','5']);
SELECT pg_temp._try_draft('lockunknown', ARRAY['1','2','3','6']);
SELECT pg_temp._try_draft('othercollection', ARRAY['1','2','3','7']);
SELECT pg_temp._try_draft('otherwallet', ARRAY['1','2','3','8']);
SELECT _assert((SELECT msg LIKE '%packs of%' FROM _gw_raised WHERE label = 'count'), 'D1 a pool of the wrong size is refused');
SELECT _assert((SELECT msg LIKE '%twice%' FROM _gw_raised WHERE label = 'dupe'), 'D2 a duplicated moment is refused');
SELECT _assert((SELECT msg LIKE '%locked%' FROM _gw_raised WHERE label = 'locked'), 'D3 a locked moment is refused');
SELECT _assert((SELECT msg LIKE '%locked%' FROM _gw_raised WHERE label = 'lockunknown'), 'D4 a moment whose lock state is unknown is refused');
SELECT _assert((SELECT msg LIKE '%not held%' FROM _gw_raised WHERE label = 'othercollection'), 'D5 a same-id moment held only in another collection is refused');
SELECT _assert((SELECT msg LIKE '%not held%' FROM _gw_raised WHERE label = 'otherwallet'), 'D6 a moment held by another wallet is refused');
SELECT _assert_eq((SELECT count(*)::text FROM giveaway_drops), '0', 'D7 a refused draft leaves no drop row behind');

-- D8: success copies exactly the pool, admin wallet lowercased
SELECT pg_temp._try_draft('ok', ARRAY['4','3','2','1']);
SELECT _assert_eq((SELECT msg FROM _gw_raised WHERE label = 'ok'), NULL, 'D8 a valid draft is created');
SELECT _assert_eq((SELECT admin_wallet || '/' || status FROM giveaway_drops), '0x00000000000000aa/draft', 'D8 draft row');
SELECT _assert_eq((SELECT string_agg(moment_id || '=' || fmv_usd, ',' ORDER BY moment_id) FROM giveaway_pack_moments),
                  '1=1.00,2=2.00,3=3.00,4=4.00', 'D8 pool copied from the cache');

-- S1..S3: seal
CREATE OR REPLACE FUNCTION pg_temp._try_seal(p_label text, p_assign jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seal_giveaway_drop((SELECT id FROM giveaway_drops), p_assign, repeat('a', 64), repeat('b', 64));
  INSERT INTO _gw_raised VALUES (p_label, NULL);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _gw_raised VALUES (p_label, SQLERRM);
END $$;
SELECT pg_temp._try_seal('dupslot', '[{"moment_id":"1","pack_no":1,"slot":1},{"moment_id":"2","pack_no":1,"slot":1},{"moment_id":"3","pack_no":2,"slot":1},{"moment_id":"4","pack_no":2,"slot":2}]');
SELECT pg_temp._try_seal('missing', '[{"moment_id":"1","pack_no":1,"slot":1},{"moment_id":"2","pack_no":1,"slot":2},{"moment_id":"3","pack_no":2,"slot":1}]');
SELECT pg_temp._try_seal('outside', '[{"moment_id":"1","pack_no":1,"slot":1},{"moment_id":"2","pack_no":1,"slot":2},{"moment_id":"3","pack_no":2,"slot":1},{"moment_id":"9","pack_no":2,"slot":2}]');
SELECT pg_temp._try_seal('badpack', '[{"moment_id":"1","pack_no":1,"slot":1},{"moment_id":"2","pack_no":1,"slot":2},{"moment_id":"3","pack_no":3,"slot":1},{"moment_id":"4","pack_no":3,"slot":2}]');
SELECT _assert((SELECT msg LIKE '%exactly once%' FROM _gw_raised WHERE label = 'dupslot'), 'S1 two moments in one slot are refused');
SELECT _assert((SELECT msg LIKE '%exactly once%' FROM _gw_raised WHERE label = 'missing'), 'S1 an assignment missing a moment is refused');
SELECT _assert((SELECT msg LIKE '%exactly once%' FROM _gw_raised WHERE label = 'outside'), 'S1 a moment outside the pool is refused');
SELECT _assert((SELECT msg LIKE '%exactly once%' FROM _gw_raised WHERE label = 'badpack'), 'S1 a pack number beyond pack_count is refused');
SELECT _assert_eq((SELECT status FROM giveaway_drops), 'draft', 'S1 a refused seal leaves the draft untouched');

SELECT pg_temp._try_seal('ok', '[{"moment_id":"1","pack_no":2,"slot":1},{"moment_id":"2","pack_no":1,"slot":2},{"moment_id":"3","pack_no":2,"slot":2},{"moment_id":"4","pack_no":1,"slot":1}]');
SELECT _assert_eq((SELECT msg FROM _gw_raised WHERE label = 'ok' AND msg IS NOT NULL LIMIT 1), NULL, 'S2 a valid seal succeeds');
SELECT _assert_eq((SELECT status || '/' || (seal_hash = repeat('a', 64))::text FROM giveaway_drops), 'sealed/true', 'S2 drop sealed with its hash');
SELECT _assert_eq((SELECT string_agg(moment_id || '@' || pack_no || '.' || slot, ',' ORDER BY moment_id) FROM giveaway_pack_moments),
                  '1@2.1,2@1.2,3@2.2,4@1.1', 'S2 every moment carries its assignment');
SELECT pg_temp._try_seal('again', '[{"moment_id":"1","pack_no":1,"slot":1},{"moment_id":"2","pack_no":1,"slot":2},{"moment_id":"3","pack_no":2,"slot":1},{"moment_id":"4","pack_no":2,"slot":2}]');
SELECT _assert((SELECT msg LIKE '%only a draft%' FROM _gw_raised WHERE label = 'again'), 'S3 a sealed drop cannot be re-sealed');
SELECT _assert_eq((SELECT pack_no::text FROM giveaway_pack_moments WHERE moment_id = '1'), '2', 'S3 the refused re-seal changed nothing');

-- C1..C8: claims
CREATE TEMP TABLE _gw_claims (who text, pack_no int, outcome text);
CREATE OR REPLACE FUNCTION pg_temp._claim(p_who text, p_user uuid, p_recipient text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _gw_claims SELECT p_who, c.pack_no, c.outcome
    FROM claim_giveaway_pack((SELECT id FROM giveaway_drops), p_user, 'user_' || p_who, p_recipient) c;
END $$;

SELECT pg_temp._claim('early', '00000000-0000-0000-0000-000000000001', '0x0000000000000001');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'early'), 'not_open', 'C1 a sealed-but-not-open drop refuses claims');

UPDATE giveaway_drops SET status = 'open', opened_at = now();
SELECT pg_temp._claim('a', '00000000-0000-0000-0000-000000000001', '0x000000000000000A');
SELECT pg_temp._claim('a2', '00000000-0000-0000-0000-000000000001', '0x0000000000000002');
SELECT pg_temp._claim('b', '00000000-0000-0000-0000-000000000002', '0x000000000000000a');
SELECT pg_temp._claim('admin', '00000000-0000-0000-0000-000000000003', '0x00000000000000aa');
SELECT pg_temp._claim('c', '00000000-0000-0000-0000-000000000004', '0x000000000000000c');
SELECT pg_temp._claim('d', '00000000-0000-0000-0000-000000000005', '0x000000000000000d');
SELECT _assert((SELECT outcome = 'claimed' AND pack_no BETWEEN 1 AND 2 FROM _gw_claims WHERE who = 'a'), 'C2 an open drop hands out a pack');
SELECT _assert((SELECT outcome = 'already_claimed' AND pack_no = (SELECT pack_no FROM _gw_claims WHERE who = 'a') FROM _gw_claims WHERE who = 'a2'),
               'C3 a second claim by the same account returns its first pack, not a new one');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'b'), 'recipient_taken', 'C4 one pack per recipient wallet (case-insensitive)');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'admin'), 'admin_recipient', 'C5 the admin cannot send a pack to their own wallet');
SELECT _assert((SELECT outcome = 'claimed' AND pack_no <> (SELECT pack_no FROM _gw_claims WHERE who = 'a') FROM _gw_claims WHERE who = 'c'),
               'C6 the next claimer gets the OTHER pack');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'd'), 'all_claimed', 'C7 no pack is handed out twice');
SELECT _assert_eq((SELECT count(*)::text || '/' || count(DISTINCT pack_no)::text FROM giveaway_claims), '2/2', 'C7 two claims, two distinct packs');
SELECT _assert_eq((SELECT recipient_address FROM giveaway_claims WHERE user_id = '00000000-0000-0000-0000-000000000001'),
                  '0x000000000000000a', 'C2 the recipient is stored lowercased');

UPDATE giveaway_drops SET status = 'closed', closed_at = now();
SELECT pg_temp._claim('late', '00000000-0000-0000-0000-000000000006', '0x000000000000000e');
SELECT pg_temp._claim('a3', '00000000-0000-0000-0000-000000000001', '0x000000000000000a');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'late'), 'not_open', 'C8 a closed drop refuses new claims');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'a3'), 'already_claimed', 'C8 an existing claimer can still read their pack after close');

SELECT _assert_eq((SELECT string_agg(DISTINCT source_wallet, ',') FROM giveaway_pack_moments), '0x00000000000000aa',
                  'D8 a v1 call (no sources) records every moment as from the admin wallet');

-- M1..M5: a pool across the sponsor's linked accounts (2026-10-03)
DELETE FROM giveaway_drops;
INSERT INTO wallet_moments_cache (wallet_address, moment_id, collection_id, player_name, fmv_usd, is_locked, last_seen_at) VALUES
  ('0x00000000000000bb', '9', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'I', 9.00, true, now());
CREATE OR REPLACE FUNCTION pg_temp._try_multi(p_label text, p_ids text[], p_sources text[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM create_giveaway_draft_multi('m-' || p_label, 'Multi drop', NULL, 'Sponsor', '95f28a17-224a-4025-96ad-adf8a4c63bfd',
                                '0x00000000000000ff', 2, 2, p_ids, p_sources);
  INSERT INTO _gw_raised VALUES ('m-' || p_label, NULL);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _gw_raised VALUES ('m-' || p_label, SQLERRM);
END $$;
SELECT pg_temp._try_multi('wrongsource', ARRAY['1','2','3','8'], ARRAY['0x00000000000000aa','0x00000000000000aa','0x00000000000000aa','0x00000000000000aa']);
-- both accounts are sources, but each moment is attributed to the WRONG one
SELECT pg_temp._try_multi('swapped', ARRAY['1','2','3','8'], ARRAY['0x00000000000000bb','0x00000000000000aa','0x00000000000000aa','0x00000000000000aa']);
SELECT pg_temp._try_multi('lengths', ARRAY['1','2','3','8'], ARRAY['0x00000000000000aa','0x00000000000000bb']);
SELECT pg_temp._try_multi('badaddr', ARRAY['1','2','3','8'], ARRAY['0x00000000000000aa','0x00000000000000aa','0x00000000000000aa','bb']);
SELECT pg_temp._try_multi('lockedsrc', ARRAY['1','2','3','9'], ARRAY['0x00000000000000aa','0x00000000000000aa','0x00000000000000aa','0x00000000000000bb']);
SELECT _assert((SELECT msg LIKE '%not held%8@0x00000000000000aa%' FROM _gw_raised WHERE label = 'm-wrongsource'), 'M1 a moment is checked against ITS source, not any linked account');
SELECT _assert((SELECT msg LIKE '%1@0x00000000000000bb%8@0x00000000000000aa%' FROM _gw_raised WHERE label = 'm-swapped'),
               'M1 pairs, not sets: a moment held by ANOTHER of the pool''s sources is still refused');
SELECT _assert((SELECT msg LIKE '%source wallets%' FROM _gw_raised WHERE label = 'm-lengths'), 'M2 one source per moment');
SELECT _assert((SELECT msg LIKE '%not a Flow 0x address%' FROM _gw_raised WHERE label = 'm-badaddr'), 'M2 a malformed source is refused');
SELECT _assert((SELECT msg LIKE '%locked%' FROM _gw_raised WHERE label = 'm-lockedsrc'), 'M3 a locked moment in a linked account is refused');
SELECT _assert_eq((SELECT count(*)::text FROM giveaway_drops), '0', 'M3 refused multi-account drafts leave nothing behind');

SELECT pg_temp._try_multi('ok', ARRAY['1','2','3','8'], ARRAY['0x00000000000000AA','0x00000000000000aa','0x00000000000000aa','0x00000000000000bb']);
SELECT _assert_eq((SELECT msg FROM _gw_raised WHERE label = 'm-ok'), NULL, 'M4 a pool across two accounts is created');
SELECT _assert_eq((SELECT admin_wallet FROM giveaway_drops), '0x00000000000000ff', 'M4 the sponsor is the connected wallet');
SELECT _assert_eq((SELECT string_agg(moment_id || '@' || source_wallet, ',' ORDER BY moment_id) FROM giveaway_pack_moments),
                  '1@0x00000000000000aa,2@0x00000000000000aa,3@0x00000000000000aa,8@0x00000000000000bb', 'M4 each moment keeps its own source (lowercased)');

UPDATE giveaway_drops SET status = 'open', seal_hash = repeat('a', 64), seal_salt = repeat('b', 64), sealed_at = now(), opened_at = now();
SELECT pg_temp._claim('srcbb', '00000000-0000-0000-0000-000000000011', '0x00000000000000BB');
SELECT pg_temp._claim('sponsor', '00000000-0000-0000-0000-000000000012', '0x00000000000000ff');
SELECT pg_temp._claim('fan', '00000000-0000-0000-0000-000000000013', '0x0000000000000013');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'srcbb'), 'admin_recipient', 'M5 a pack can not be claimed to a linked account the pool comes from');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'sponsor'), 'admin_recipient', 'M5 nor to the sponsor wallet');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'fan'), 'claimed', 'M5 anyone else still claims');

-- B1..B4: the balanced deal (2026-11-08). Pool 21=$10, 22=$8, 23=$5, 24=$1 in 2 packs of 2:
-- band 1 = {21, 22} must fill slot 1, band 2 = {23, 24} slot 2.
INSERT INTO giveaway_drops (slug, title, sponsor_name, collection_id, admin_wallet, pack_count, moments_per_pack)
VALUES ('bal-one', 'Balanced one', 'Trevor', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '0x00000000000000aa', 2, 2),
       ('bal-two', 'Balanced two', 'Trevor', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '0x00000000000000aa', 2, 2);
INSERT INTO giveaway_pack_moments (drop_id, moment_id, fmv_usd, source_wallet)
SELECT d.id, v.id, v.fmv, '0x00000000000000aa'
  FROM giveaway_drops d CROSS JOIN (VALUES ('21', 10), ('22', 8), ('23', 5), ('24', 1)) v(id, fmv)
 WHERE d.slug IN ('bal-one', 'bal-two');
CREATE OR REPLACE FUNCTION pg_temp._try_dealt(p_label text, p_slug text, p_mode text, p_assign jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seal_giveaway_drop_dealt((SELECT id FROM giveaway_drops WHERE slug = p_slug), p_assign, repeat('c', 64), repeat('d', 64), p_mode);
  INSERT INTO _gw_raised VALUES (p_label, NULL);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _gw_raised VALUES (p_label, SQLERRM);
END $$;
-- both top-band moments in pack 1: valid coverage, NOT balanced
SELECT pg_temp._try_dealt('b-stacked', 'bal-one', 'balanced', '[{"moment_id":"21","pack_no":1,"slot":1},{"moment_id":"22","pack_no":1,"slot":2},{"moment_id":"23","pack_no":2,"slot":1},{"moment_id":"24","pack_no":2,"slot":2}]');
SELECT pg_temp._try_dealt('b-mode', 'bal-one', 'fair', '[{"moment_id":"21","pack_no":1,"slot":1},{"moment_id":"22","pack_no":2,"slot":1},{"moment_id":"23","pack_no":2,"slot":2},{"moment_id":"24","pack_no":1,"slot":2}]');
SELECT _assert((SELECT msg LIKE '%not a balanced deal%' FROM _gw_raised WHERE label = 'b-stacked'), 'B1 a balanced seal that stacks the top band in one pack is refused');
SELECT _assert((SELECT msg LIKE '%random or balanced%' FROM _gw_raised WHERE label = 'b-mode'), 'B1 an unknown deal mode is refused');
SELECT _assert_eq((SELECT status || '/' || deal_mode FROM giveaway_drops WHERE slug = 'bal-one'), 'draft/random', 'B2 a refused balanced seal leaves the draft untouched');
SELECT _assert_eq((SELECT count(*)::text FROM giveaway_pack_moments m JOIN giveaway_drops d ON d.id = m.drop_id
                    WHERE d.slug = 'bal-one' AND m.pack_no IS NOT NULL), '0', 'B2 and assigns nothing');
SELECT pg_temp._try_dealt('b-ok', 'bal-one', 'balanced', '[{"moment_id":"21","pack_no":2,"slot":1},{"moment_id":"22","pack_no":1,"slot":1},{"moment_id":"23","pack_no":1,"slot":2},{"moment_id":"24","pack_no":2,"slot":2}]');
SELECT _assert_eq((SELECT msg FROM _gw_raised WHERE label = 'b-ok'), NULL, 'B3 a balanced deal (one per band per pack) is sealed');
SELECT _assert_eq((SELECT status || '/' || deal_mode FROM giveaway_drops WHERE slug = 'bal-one'), 'sealed/balanced', 'B3 the drop records the balanced mode');
-- the same stacked assignment is a legitimate RANDOM deal
SELECT pg_temp._try_dealt('r-ok', 'bal-two', 'random', '[{"moment_id":"21","pack_no":1,"slot":1},{"moment_id":"22","pack_no":1,"slot":2},{"moment_id":"23","pack_no":2,"slot":1},{"moment_id":"24","pack_no":2,"slot":2}]');
SELECT _assert_eq((SELECT msg FROM _gw_raised WHERE label = 'r-ok'), NULL, 'B4 a random seal accepts any exactly-once deal');
SELECT _assert_eq((SELECT status || '/' || deal_mode FROM giveaway_drops WHERE slug = 'bal-two'), 'sealed/random', 'B4 and records the random mode');

-- V1..V5: instant delivery from the giveaway vault (2026-11-08, 20261108231643).
-- Drop vault-one: 2 packs of 1, moments 41 (from 0x…aa) and 42 (from 0x…bb), sealed, not yet open.
INSERT INTO giveaway_drops (slug, title, sponsor_name, collection_id, admin_wallet, pack_count, moments_per_pack, status, seal_hash, seal_salt, sealed_at)
VALUES ('vault-one', 'Vault one', 'Trevor', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '0x00000000000000ff', 2, 1, 'sealed', repeat('a', 64), repeat('b', 64), now()),
       ('vault-draft', 'Vault draft', 'Trevor', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '0x00000000000000ff', 1, 1, 'draft', NULL, NULL, NULL);
INSERT INTO giveaway_pack_moments (drop_id, moment_id, pack_no, slot, fmv_usd, source_wallet)
SELECT d.id, v.id, v.pack, 1, 5, v.src FROM giveaway_drops d CROSS JOIN (VALUES ('41', 1, '0x00000000000000aa'), ('42', 2, '0x00000000000000bb')) v(id, pack, src)
 WHERE d.slug = 'vault-one';
CREATE OR REPLACE FUNCTION pg_temp._try_fund(p_label text, p_slug text, p_vault text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mark_giveaway_vault_funded((SELECT id FROM giveaway_drops WHERE slug = p_slug), p_vault);
  INSERT INTO _gw_raised VALUES (p_label, NULL);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _gw_raised VALUES (p_label, SQLERRM);
END $$;
SELECT pg_temp._try_fund('v-draft', 'vault-draft', '0x00000000000000cc');
SELECT _assert((SELECT msg LIKE '%only a sealed or open drop%' FROM _gw_raised WHERE label = 'v-draft'), 'V1 a draft cannot be funded');
SELECT _assert_eq((SELECT mark_giveaway_vault_funded((SELECT id FROM giveaway_drops WHERE slug = 'vault-one'), '0x00000000000000CC'))::text, '2', 'V1 funding moves every undelivered moment to the vault');
SELECT _assert_eq((SELECT string_agg(moment_id || ':' || source_wallet || '<' || funded_from, ',' ORDER BY moment_id) FROM giveaway_pack_moments m
                    JOIN giveaway_drops d ON d.id = m.drop_id WHERE d.slug = 'vault-one'),
                  '41:0x00000000000000cc<0x00000000000000aa,42:0x00000000000000cc<0x00000000000000bb', 'V1 each moment remembers where it came from');
SELECT _assert_eq((SELECT mark_giveaway_vault_funded((SELECT id FROM giveaway_drops WHERE slug = 'vault-one'), '0x00000000000000cc'))::text, '0', 'V1 re-funding the same vault is a no-op');
SELECT pg_temp._try_fund('v-other', 'vault-one', '0x00000000000000dd');
SELECT _assert((SELECT msg LIKE '%already funded%' FROM _gw_raised WHERE label = 'v-other'), 'V1 a funded drop cannot be moved to another vault');
SELECT _assert_eq((SELECT funded_from FROM giveaway_pack_moments WHERE moment_id = '41' AND drop_id = (SELECT id FROM giveaway_drops WHERE slug = 'vault-one')),
                  '0x00000000000000aa', 'V1 a refused re-fund keeps the original origin');

-- V2: once funded, the accounts the pool came from still cannot win it
UPDATE giveaway_drops SET status = 'open', opened_at = now() WHERE slug = 'vault-one';
CREATE OR REPLACE FUNCTION pg_temp._claim_slug(p_who text, p_slug text, p_user uuid, p_recipient text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _gw_claims SELECT p_who, c.pack_no, c.outcome FROM claim_giveaway_pack((SELECT id FROM giveaway_drops WHERE slug = p_slug), p_user, p_who, p_recipient) c;
END $$;
SELECT pg_temp._claim_slug('v-origin', 'vault-one', '00000000-0000-0000-0000-000000000021', '0x00000000000000BB');
SELECT pg_temp._claim_slug('v-vault', 'vault-one', '00000000-0000-0000-0000-000000000022', '0x00000000000000cc');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'v-origin'), 'admin_recipient', 'V2 a funded-from account cannot claim the pool it funded');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'v-vault'), 'admin_recipient', 'V2 nor can the vault itself');
SELECT pg_temp._claim_slug('v-fan', 'vault-one', '00000000-0000-0000-0000-000000000023', '0x0000000000000023');
SELECT _assert_eq((SELECT outcome FROM _gw_claims WHERE who = 'v-fan'), 'claimed', 'V2 anyone else claims');

-- V3: the send lock hands out the claimed pack's moments with the CLAIM's recipient, once
CREATE TEMP TABLE _gw_sends (label text, moment_id text, recipient text);
INSERT INTO _gw_sends SELECT 's1', r.moment_id, r.recipient FROM reserve_giveaway_vault_send((SELECT id FROM giveaway_drops WHERE slug = 'vault-one'), NULL, false) r;
INSERT INTO _gw_sends SELECT 's2', r.moment_id, r.recipient FROM reserve_giveaway_vault_send((SELECT id FROM giveaway_drops WHERE slug = 'vault-one'), NULL, false) r;
SELECT _assert_eq((SELECT string_agg(moment_id || '>' || recipient, ',') FROM _gw_sends WHERE label = 's1'),
                  (SELECT m.moment_id || '>0x0000000000000023' FROM giveaway_pack_moments m JOIN giveaway_claims c ON c.drop_id = m.drop_id AND c.pack_no = m.pack_no
                    WHERE c.recipient_address = '0x0000000000000023'), 'V3 only the claimed pack, to the claim''s recipient');
SELECT _assert_eq((SELECT count(*)::text FROM _gw_sends WHERE label = 's2'), '0', 'V3 a second trigger within the lock window sends nothing');
UPDATE giveaway_pack_moments SET delivery_attempted_at = now() - interval '4 minutes' WHERE delivery_attempted_at IS NOT NULL;
INSERT INTO _gw_sends SELECT 's3', r.moment_id, r.recipient FROM reserve_giveaway_vault_send((SELECT id FROM giveaway_drops WHERE slug = 'vault-one'), NULL, false) r;
SELECT _assert_eq((SELECT count(*)::text FROM _gw_sends WHERE label = 's3'), '1', 'V3 an attempt older than 3 minutes is retried');
UPDATE giveaway_pack_moments SET delivered_at = now() WHERE delivery_attempted_at IS NOT NULL;
UPDATE giveaway_pack_moments SET delivery_attempted_at = now() - interval '4 minutes' WHERE delivered_at IS NOT NULL;
INSERT INTO _gw_sends SELECT 's4', r.moment_id, r.recipient FROM reserve_giveaway_vault_send((SELECT id FROM giveaway_drops WHERE slug = 'vault-one'), NULL, false) r;
SELECT _assert_eq((SELECT count(*)::text FROM _gw_sends WHERE label = 's4'), '0', 'V3 a delivered moment is never handed out again');

-- V4: unclaimed moments go back to where they came from, only after close
CREATE OR REPLACE FUNCTION pg_temp._try_return(p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _gw_sends SELECT p_label, r.moment_id, r.recipient FROM reserve_giveaway_vault_send((SELECT id FROM giveaway_drops WHERE slug = 'vault-one'), NULL, true) r;
  INSERT INTO _gw_raised VALUES (p_label, NULL);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _gw_raised VALUES (p_label, SQLERRM);
END $$;
SELECT pg_temp._try_return('r-open');
SELECT _assert((SELECT msg LIKE '%only after the drop closes%' FROM _gw_raised WHERE label = 'r-open'), 'V4 nothing goes back while the drop is open');
UPDATE giveaway_drops SET status = 'closed', closed_at = now() WHERE slug = 'vault-one';
SELECT pg_temp._try_return('r-closed');
SELECT _assert_eq((SELECT string_agg(s.moment_id || '>' || s.recipient, ',') FROM _gw_sends s WHERE s.label = 'r-closed'),
                  (SELECT m.moment_id || '>' || m.funded_from FROM giveaway_pack_moments m JOIN giveaway_drops d ON d.id = m.drop_id
                    WHERE d.slug = 'vault-one' AND m.delivered_at IS NULL), 'V4 the unclaimed moment goes back to the account it was funded from');

-- V5: an unfunded drop hands out nothing
INSERT INTO _gw_sends SELECT 'unfunded', r.moment_id, r.recipient FROM reserve_giveaway_vault_send((SELECT id FROM giveaway_drops WHERE slug = 'bal-one'), NULL, false) r;
SELECT _assert_eq((SELECT count(*)::text FROM _gw_sends WHERE label = 'unfunded'), '0', 'V5 an unfunded drop has nothing to send from a vault');

SELECT '✓ giveaways: draft refusals (size, duplicate, locked, unknown lock, other collection, other wallet), seal coverage, claim outcomes, multi-account pools, balanced deal, vault funding + send lock + returns' AS result;

ROLLBACK;
